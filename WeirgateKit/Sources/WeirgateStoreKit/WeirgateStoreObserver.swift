import Foundation
import StoreKit
import WeirgateKit

/// The two WeirgateKit calls the observer makes. `WeirgateClient` conforms; tests and apps
/// with their own wrapper can supply another implementation.
public protocol WeirgateStoreRedeeming: Sendable {
    func balance() async throws -> WeirgateResponse<Balance>
    func redeemAppStoreTransaction(jws: String) async throws -> WeirgateResponse<PurchaseRedemption>
}

extension WeirgateClient: WeirgateStoreRedeeming {}

/// What happened to one transaction the observer sent to Weirgate.
public enum WeirgateRedemptionOutcome: Sendable {
    /// Weirgate credited the purchase (`granted` or `alreadyGranted`). The transaction was
    /// finished.
    case redeemed(PurchaseRedemption)
    /// The App Store refunded or revoked the purchase (`purchase_revoked`). The transaction
    /// was finished and nothing was credited.
    case revoked(PurchaseRedemptionError)
    /// Weirgate rejected the record permanently (any other `purchase_*` error, or
    /// `payments_not_configured`). The transaction was left unfinished and is not retried
    /// in this session; StoreKit offers it again from `Transaction.unfinished` on the next
    /// launch, or when the app calls ``WeirgateStoreObserver/redeemUnfinished()`` after a fix.
    case rejected(PurchaseRedemptionError)
    /// Weirgate could not be reached after the retry policy ran out, or the call failed for
    /// another reason (for example an expired end-user token). The transaction was left
    /// unfinished.
    case failed(any Error)

    /// True when the observer called `Transaction.finish()`.
    public var finishedTransaction: Bool {
        switch self {
        case .redeemed, .revoked: true
        case .rejected, .failed: false
        }
    }
}

/// One redemption, reported on ``WeirgateStoreObserver/events``.
public struct WeirgateStoreEvent: Sendable {
    public enum Source: Sendable, Equatable {
        /// ``WeirgateStoreObserver/purchase(_:appAccountToken:options:)`` or
        /// ``WeirgateStoreObserver/handle(_:)``.
        case purchase
        /// `Transaction.unfinished`, at ``WeirgateStoreObserver/start()`` or
        /// ``WeirgateStoreObserver/redeemUnfinished()``.
        case unfinished
        /// `Transaction.updates` (Ask to Buy approvals, other devices, refunds).
        case updates
    }

    public let transactionID: UInt64
    public let productID: String
    public let source: Source
    public let outcome: WeirgateRedemptionOutcome
}

/// Result of a purchase made through the observer.
public enum WeirgatePurchaseResult: Sendable {
    /// The purchase succeeded in StoreKit and was sent to Weirgate.
    case completed(WeirgateRedemptionOutcome)
    /// Waiting on Ask to Buy or another approval. It arrives later through
    /// `Transaction.updates` and is reported on ``WeirgateStoreObserver/events``.
    case pending
    case userCancelled
}

/// Bounded exponential backoff for transport errors, 5xx responses, and `rate_limited`.
public struct WeirgateStoreRetryPolicy: Sendable, Equatable {
    /// Total attempts per transaction, including the first.
    public var maxAttempts: Int
    public var initialDelay: Duration
    public var maxDelay: Duration

    public init(maxAttempts: Int = 4, initialDelay: Duration = .seconds(1), maxDelay: Duration = .seconds(30)) {
        self.maxAttempts = max(1, maxAttempts)
        self.initialDelay = initialDelay
        self.maxDelay = maxDelay
    }

    public static let `default` = WeirgateStoreRetryPolicy()

    func delay(afterAttempt attempt: Int, retryAfter: TimeInterval?) -> Duration {
        let backoff = initialDelay * (1 << min(attempt - 1, 20))
        let requested = retryAfter.map { Duration.seconds($0) } ?? .zero
        return min(maxDelay, max(backoff, requested))
    }
}

/// Redeems StoreKit 2 consumable purchases with Weirgate and finishes them by Weirgate's rules.
///
/// - At ``start()`` it redeems every `Transaction.unfinished`, then keeps listening to
///   `Transaction.updates`.
/// - It calls `finish()` only after Weirgate returns 200, or `purchase_revoked`.
/// - Other `purchase_*` errors and `payments_not_configured` are permanent for that record:
///   no retry loop, the transaction stays unfinished, and the app hears about it on
///   ``events``.
/// - Transport errors, 5xx responses, and `rate_limited` are retried with
///   ``WeirgateStoreRetryPolicy``.
/// - Two redemptions of one transaction never run at the same time: a second request
///   (for example `Transaction.updates` while the launch sweep is still running) waits for
///   the first and gets its outcome.
///
/// Create one observer per app process, early (for example in the `App` initializer), and
/// call ``start()``.
public actor WeirgateStoreObserver {
    /// Every redemption outcome, from all sources. Single consumer; buffers the newest 100.
    public nonisolated let events: AsyncStream<WeirgateStoreEvent>

    private let client: any WeirgateStoreRedeeming
    private let retryPolicy: WeirgateStoreRetryPolicy
    private let shouldRedeem: @Sendable (Transaction) -> Bool
    private let continuation: AsyncStream<WeirgateStoreEvent>.Continuation
    private var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    private var inFlight: [UInt64: Task<WeirgateRedemptionOutcome, Never>] = [:]
    private var listeners: [Task<Void, Never>] = []

    /// - Parameters:
    ///   - client: usually your `WeirgateClient`.
    ///   - shouldRedeem: which transactions from `Transaction.unfinished` and
    ///     `Transaction.updates` belong to Weirgate. Defaults to consumables; narrow it if
    ///     the app also sells products handled elsewhere. Purchases made through
    ///     ``purchase(_:appAccountToken:options:)`` and ``handle(_:)`` are always redeemed.
    public init(
        client: some WeirgateStoreRedeeming,
        retryPolicy: WeirgateStoreRetryPolicy = .default,
        shouldRedeem: @escaping @Sendable (Transaction) -> Bool = { $0.productType == .consumable }
    ) {
        self.client = client
        self.retryPolicy = retryPolicy
        self.shouldRedeem = shouldRedeem
        (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(100))
    }

    deinit {
        listeners.forEach { $0.cancel() }
        continuation.finish()
    }

    /// Starts listening to `Transaction.updates` and redeems `Transaction.unfinished`.
    /// Calling it again does nothing until ``stop()``.
    public func start() {
        guard listeners.isEmpty else { return }
        listeners.append(Task { [weak self] in
            for await verification in Transaction.updates {
                guard let self else { return }
                Task { await self.redeemIfOwned(verification, source: .updates) }
            }
        })
        listeners.append(Task { [weak self] in
            _ = await self?.redeemUnfinished()
        })
    }

    public func stop() {
        listeners.forEach { $0.cancel() }
        listeners.removeAll()
    }

    /// Redeems every unfinished transaction that ``init(client:retryPolicy:shouldRedeem:)``'s
    /// `shouldRedeem` accepts, and returns what happened. Call it after something that can
    /// change the answer: the user signed in, or the app's Weirgate payments config was fixed.
    @discardableResult
    public func redeemUnfinished() async -> [WeirgateStoreEvent] {
        var owned: [VerificationResult<Transaction>] = []
        for await verification in Transaction.unfinished where shouldRedeem(verification.unsafePayloadValue) {
            owned.append(verification)
        }
        return await withTaskGroup(of: WeirgateStoreEvent.self) { group in
            for verification in owned {
                group.addTask { await self.redeem(verification, source: .unfinished) }
            }
            var events: [WeirgateStoreEvent] = []
            for await event in group { events.append(event) }
            return events
        }
    }

    /// Buys `product` with the user's `appAccountToken`, then redeems and finishes it.
    ///
    /// - Parameter appAccountToken: `Balance.appAccountToken` for the signed-in user. When
    ///   `nil`, the observer reads the balance first to get it.
    public func purchase(
        _ product: Product,
        appAccountToken: UUID? = nil,
        options: Set<Product.PurchaseOption> = []
    ) async throws -> WeirgatePurchaseResult {
        let token: UUID
        if let appAccountToken {
            token = appAccountToken
        } else {
            token = try await client.balance().value.appAccountToken
        }
        var purchaseOptions = options
        purchaseOptions.insert(.appAccountToken(token))
        return await handle(try await product.purchase(options: purchaseOptions))
    }

    /// Redeems the result of a purchase the app started itself (for example with SwiftUI's
    /// `PurchaseAction`). Include `.appAccountToken(balance.appAccountToken)` in that
    /// purchase's options.
    public func handle(_ result: Product.PurchaseResult) async -> WeirgatePurchaseResult {
        switch result {
        case .success(let verification):
            return .completed(await redeem(verification, source: .purchase).outcome)
        case .pending:
            return .pending
        case .userCancelled:
            return .userCancelled
        @unknown default:
            return .pending
        }
    }

    private func redeemIfOwned(_ verification: VerificationResult<Transaction>, source: WeirgateStoreEvent.Source) async {
        guard shouldRedeem(verification.unsafePayloadValue) else { return }
        _ = await redeem(verification, source: source)
    }

    private func redeem(_ verification: VerificationResult<Transaction>, source: WeirgateStoreEvent.Source) async -> WeirgateStoreEvent {
        // Unverified records are sent too: Weirgate checks Apple's signature itself and
        // answers purchase_invalid_signature, which leaves the transaction unfinished.
        let transaction = verification.unsafePayloadValue
        return await process(
            RedeemableTransaction(
                id: transaction.id,
                productID: transaction.productID,
                jws: verification.jwsRepresentation,
                finish: { await transaction.finish() }
            ),
            source: source
        )
    }

    func process(_ transaction: RedeemableTransaction, source: WeirgateStoreEvent.Source) async -> WeirgateStoreEvent {
        if let running = inFlight[transaction.id] {
            return WeirgateStoreEvent(
                transactionID: transaction.id,
                productID: transaction.productID,
                source: source,
                outcome: await running.value
            )
        }
        let task = Task { await self.redeemWithRetry(transaction) }
        inFlight[transaction.id] = task
        let outcome = await task.value
        inFlight[transaction.id] = nil
        let event = WeirgateStoreEvent(
            transactionID: transaction.id,
            productID: transaction.productID,
            source: source,
            outcome: outcome
        )
        continuation.yield(event)
        return event
    }

    private func redeemWithRetry(_ transaction: RedeemableTransaction) async -> WeirgateRedemptionOutcome {
        var attempt = 1
        while true {
            do {
                let redemption = try await client.redeemAppStoreTransaction(jws: transaction.jws).value
                await transaction.finish()
                return .redeemed(redemption)
            } catch let error as PurchaseRedemptionError {
                guard error.shouldFinishTransaction else { return .rejected(error) }
                await transaction.finish()
                return .revoked(error)
            } catch {
                guard Self.isTransient(error), attempt < retryPolicy.maxAttempts else { return .failed(error) }
                do {
                    try await sleep(retryPolicy.delay(afterAttempt: attempt, retryAfter: (error as? WeirgateError)?.retryAfter))
                } catch {
                    return .failed(error)
                }
                attempt += 1
            }
        }
    }

    static func isTransient(_ error: any Error) -> Bool {
        switch error {
        case let error as WeirgateError:
            return error.statusCode >= 500 || error.type == .rateLimited
        case let error as WeirgateSDKError:
            switch error {
            case .transport, .invalidResponse, .invalidBody: return true
            case .invalidConfiguration, .invalidStream, .interruptedStream: return false
            }
        default:
            return false
        }
    }

    func setSleepForTesting(_ sleep: @escaping @Sendable (Duration) async throws -> Void) {
        self.sleep = sleep
    }
}

/// The parts of a StoreKit transaction the observer uses, so the finish rules can be
/// tested without StoreKit.
struct RedeemableTransaction: Sendable {
    let id: UInt64
    let productID: String
    let jws: String
    let finish: @Sendable () async -> Void
}

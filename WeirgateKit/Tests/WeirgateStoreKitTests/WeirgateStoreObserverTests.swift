import Foundation
import Testing
@testable import WeirgateKit
@testable import WeirgateStoreKit

/// Scripted stand-in for WeirgateClient: each redeem call takes the next result.
actor StubRedeemer: WeirgateStoreRedeeming {
    enum Step: Sendable {
        case success(PurchaseRedemption)
        case failure(any Error)
    }

    private var steps: [Step]
    private(set) var redeemCalls: [String] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var holdFirstCall: Bool
    let token = UUID()

    init(_ steps: [Step], holdFirstCall: Bool = false) {
        self.steps = steps
        self.holdFirstCall = holdFirstCall
    }

    func balance() async throws -> WeirgateResponse<Balance> {
        WeirgateResponse(
            value: Balance(unitsAvailable: 0, unitsPending: 0, tier: "free", appAccountToken: token),
            metadata: .init(requestID: "req_balance", apiVersion: "2026-07-18", statusCode: 200)
        )
    }

    func redeemAppStoreTransaction(jws: String) async throws -> WeirgateResponse<PurchaseRedemption> {
        redeemCalls.append(jws)
        if holdFirstCall {
            holdFirstCall = false
            await withCheckedContinuation { gate = $0 }
        }
        let step = steps.isEmpty ? .failure(WeirgateSDKError.transport("exhausted")) : steps.removeFirst()
        switch step {
        case .success(let value):
            return WeirgateResponse(value: value, metadata: .init(requestID: "req_redeem", apiVersion: "2026-07-18", statusCode: 200))
        case .failure(let error):
            throw error
        }
    }

    func release() {
        gate?.resume()
        gate = nil
    }

    var isHolding: Bool { gate != nil }
}

actor FinishCounter {
    private(set) var count = 0
    func finish() { count += 1 }
}

actor SleepLog {
    private(set) var delays: [Duration] = []
    func record(_ delay: Duration) { delays.append(delay) }
}

func redemption(_ status: PurchaseRedemption.Status = .granted, units: Double = 100) -> PurchaseRedemption {
    PurchaseRedemption(
        status: status,
        units: units,
        grantID: "grant_1",
        transactionID: "2000000000000001",
        productID: "com.weirgate.test.credits.small",
        environment: .test,
        unitsAvailable: units,
        unitsPending: 0
    )
}

func serverError(
    _ type: WeirgateErrorType,
    status: Int,
    reason: String? = nil,
    retryAfter: TimeInterval? = nil
) -> WeirgateError {
    WeirgateError(
        type: type,
        statusCode: status,
        requestID: "req_error",
        apiVersion: "2026-07-18",
        serverMessage: nil,
        detail: reason.map { ["reason": .string($0)] },
        retryAfter: retryAfter
    )
}

func purchaseError(_ type: WeirgateErrorType, status: Int, reason: String) -> PurchaseRedemptionError {
    PurchaseRedemptionError(serverError(type, status: status, reason: reason))!
}

func makeObserver(_ stub: StubRedeemer, sleeps: SleepLog = SleepLog()) async -> WeirgateStoreObserver {
    let observer = WeirgateStoreObserver(client: stub)
    await observer.setSleepForTesting { await sleeps.record($0) }
    return observer
}

func transaction(id: UInt64 = 1, counter: FinishCounter) -> RedeemableTransaction {
    RedeemableTransaction(id: id, productID: "com.weirgate.test.credits.small", jws: "jws-\(id)") {
        await counter.finish()
    }
}

@Test("a 200 redemption finishes the transaction, for granted and already_granted")
func finishesOnSuccess() async throws {
    for status in [PurchaseRedemption.Status.granted, .alreadyGranted] {
        let stub = StubRedeemer([.success(redemption(status))])
        let counter = FinishCounter()
        let event = await makeObserver(stub).process(transaction(counter: counter), source: .unfinished)
        guard case .redeemed(let value) = event.outcome else {
            Issue.record("expected redeemed, got \(event.outcome)")
            continue
        }
        #expect(value.status == status)
        #expect(event.outcome.finishedTransaction)
        #expect(await counter.count == 1)
        #expect(await stub.redeemCalls == ["jws-1"])
    }
}

@Test("purchase_revoked finishes the transaction without credit")
func finishesOnRevoked() async throws {
    let stub = StubRedeemer([.failure(purchaseError(.purchaseRevoked, status: 409, reason: "transaction_refunded"))])
    let counter = FinishCounter()
    let event = await makeObserver(stub).process(transaction(counter: counter), source: .updates)
    guard case .revoked(let error) = event.outcome else {
        Issue.record("expected revoked, got \(event.outcome)")
        return
    }
    #expect(error.code == .revoked)
    #expect(await counter.count == 1)
}

@Test("other purchase rejections leave the transaction unfinished and are not retried")
func permanentRejections() async throws {
    let cases: [(PurchaseRedemptionError, PurchaseRedemptionError.Code)] = [
        (purchaseError(.purchaseInvalidSignature, status: 400, reason: "x5c_chain_invalid"), .invalidSignature),
        (purchaseError(.purchaseWrongApp, status: 422, reason: "bundle_id_mismatch"), .wrongApp),
        (purchaseError(.purchaseEnvironmentMismatch, status: 422, reason: "environment_not_allowed"), .environmentMismatch),
        (purchaseError(.purchaseUnknownProduct, status: 422, reason: "product_not_mapped"), .unknownProduct),
        (purchaseError(.purchaseAccountMismatch, status: 403, reason: "app_account_token_mismatch"), .accountMismatch),
        (purchaseError(.resourceNotFound, status: 404, reason: "payments_not_configured"), .paymentsNotConfigured),
    ]
    for (error, code) in cases {
        let stub = StubRedeemer([.failure(error), .success(redemption())])
        let counter = FinishCounter()
        let sleeps = SleepLog()
        let event = await makeObserver(stub, sleeps: sleeps).process(transaction(counter: counter), source: .unfinished)
        guard case .rejected(let rejected) = event.outcome else {
            Issue.record("expected rejected for \(code), got \(event.outcome)")
            continue
        }
        #expect(rejected.code == code)
        #expect(!event.outcome.finishedTransaction)
        #expect(await counter.count == 0)
        #expect(await stub.redeemCalls.count == 1)
        #expect(await sleeps.delays.isEmpty)
    }
}

@Test("transport errors and 5xx retry with bounded backoff, then leave the transaction unfinished")
func transientRetriesAreBounded() async throws {
    let stub = StubRedeemer([
        .failure(WeirgateSDKError.transport("URLError")),
        .failure(serverError(.internalError, status: 500)),
        .failure(serverError(.rateLimited, status: 429, retryAfter: 7)),
        .failure(WeirgateSDKError.invalidResponse(requestID: "unavailable", apiVersion: "2026-07-18", statusCode: 502)),
        .success(redemption()),
    ])
    let counter = FinishCounter()
    let sleeps = SleepLog()
    let event = await makeObserver(stub, sleeps: sleeps).process(transaction(counter: counter), source: .unfinished)
    guard case .failed = event.outcome else {
        Issue.record("expected failed, got \(event.outcome)")
        return
    }
    #expect(await stub.redeemCalls.count == WeirgateStoreRetryPolicy.default.maxAttempts)
    // 1s, 2s, then Retry-After 7s beats the 4s backoff.
    #expect(await sleeps.delays == [.seconds(1), .seconds(2), .seconds(7)])
    #expect(await counter.count == 0)
}

@Test("a transient failure followed by success finishes the transaction")
func retryThenSuccess() async throws {
    let stub = StubRedeemer([.failure(serverError(.internalError, status: 503)), .success(redemption())])
    let counter = FinishCounter()
    let event = await makeObserver(stub).process(transaction(counter: counter), source: .unfinished)
    #expect(event.outcome.finishedTransaction)
    #expect(await stub.redeemCalls.count == 2)
    #expect(await counter.count == 1)
}

@Test("non-purchase client errors such as invalid_token are not retried")
func authErrorsAreNotRetried() async throws {
    let stub = StubRedeemer([.failure(serverError(.invalidToken, status: 401)), .success(redemption())])
    let counter = FinishCounter()
    let event = await makeObserver(stub).process(transaction(counter: counter), source: .unfinished)
    guard case .failed = event.outcome else {
        Issue.record("expected failed, got \(event.outcome)")
        return
    }
    #expect(await stub.redeemCalls.count == 1)
    #expect(await counter.count == 0)
}

@Test("two redemptions of one transaction never run concurrently")
func concurrentRedemptionsShareOneCall() async throws {
    let stub = StubRedeemer([.success(redemption()), .success(redemption(.alreadyGranted))], holdFirstCall: true)
    let counter = FinishCounter()
    let observer = await makeObserver(stub)
    let item = transaction(id: 42, counter: counter)

    async let first = observer.process(item, source: .unfinished)
    while await !stub.isHolding { await Task.yield() }
    async let second = observer.process(item, source: .updates)
    // Give the second request time to reach the in-flight check before releasing.
    try await Task.sleep(for: .milliseconds(50))
    await stub.release()

    let (a, b) = await (first, second)
    #expect(await stub.redeemCalls.count == 1)
    #expect(await counter.count == 1)
    #expect(a.outcome.finishedTransaction && b.outcome.finishedTransaction)
    #expect(Set([a.source, b.source]) == [.unfinished, .updates])
}

@Test("each processed transaction is reported once on events")
func eventsStream() async throws {
    let stub = StubRedeemer([
        .success(redemption()),
        .failure(purchaseError(.purchaseAccountMismatch, status: 403, reason: "app_account_token_mismatch")),
    ])
    let counter = FinishCounter()
    let observer = await makeObserver(stub)
    _ = await observer.process(transaction(id: 1, counter: counter), source: .purchase)
    _ = await observer.process(transaction(id: 2, counter: counter), source: .updates)

    var iterator = observer.events.makeAsyncIterator()
    let first = await iterator.next()
    let second = await iterator.next()
    #expect(first?.transactionID == 1)
    #expect(first?.source == .purchase)
    #expect(first?.outcome.finishedTransaction == true)
    #expect(second?.transactionID == 2)
    if case .rejected(let error) = second?.outcome {
        #expect(error.code == .accountMismatch)
        #expect(error.reason == "app_account_token_mismatch")
    } else {
        Issue.record("expected rejected, got \(String(describing: second?.outcome))")
    }
}

@Test("retry delays are capped by the policy maximum")
func retryDelayCap() {
    let policy = WeirgateStoreRetryPolicy(maxAttempts: 10, initialDelay: .seconds(1), maxDelay: .seconds(30))
    #expect(policy.delay(afterAttempt: 1, retryAfter: nil) == .seconds(1))
    #expect(policy.delay(afterAttempt: 3, retryAfter: nil) == .seconds(4))
    #expect(policy.delay(afterAttempt: 8, retryAfter: nil) == .seconds(30))
    #expect(policy.delay(afterAttempt: 1, retryAfter: 120) == .seconds(30))
}

@Test("by default the observer redeems consumables and auto-renewable subscriptions only")
func defaultRedeemedProductTypes() {
    #expect(WeirgateStoreObserver.isRedeemedByDefault(.consumable))
    #expect(WeirgateStoreObserver.isRedeemedByDefault(.autoRenewable))
    #expect(!WeirgateStoreObserver.isRedeemedByDefault(.nonConsumable))
    #expect(!WeirgateStoreObserver.isRedeemedByDefault(.nonRenewable))
}

@Test("a subscription redemption finishes the transaction like a consumable")
func finishesSubscription() async throws {
    let value = PurchaseRedemption(
        status: .granted, units: 0, transactionID: "2000000000000002", productID: "com.weirgate.test.pro.monthly",
        environment: .test, unitsAvailable: 500, kind: .subscription, originalTransactionID: "2000000000000001", tier: "pro",
        subscription: .init(tier: "pro", status: .active, expiresAt: Date(timeIntervalSince1970: 1_793_782_800), active: true, planApplied: true)
    )
    let stub = StubRedeemer([.success(value)])
    let counter = FinishCounter()
    let event = await makeObserver(stub).process(transaction(id: 2, counter: counter), source: .currentEntitlements)
    guard case .redeemed(let redeemed) = event.outcome else {
        Issue.record("expected redeemed, got \(event.outcome)")
        return
    }
    #expect(redeemed.kind == .subscription)
    #expect(event.source == .currentEntitlements)
    #expect(await counter.count == 1)
}

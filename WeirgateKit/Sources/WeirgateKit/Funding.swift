import Foundation

/// Where the provider cost of one request is borne. Open-ended: Weirgate may add rails, so
/// an unknown value decodes instead of failing.
public struct FundingRail: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    /// The user's subscription with a model vendor (``PlanProvider``), by OAuth token.
    public static let userPlan = FundingRail(rawValue: "user_plan")
    /// The user's own provider key (``UserProviderKey``).
    public static let userKey = FundingRail(rawValue: "user_key")
    /// The app owner pays; the user spends units.
    public static let developer = FundingRail(rawValue: "developer")

    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }
}

/// A subscription provider the `user_plan` rail forwards to. Open-ended.
public struct PlanProvider: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    /// The user's ChatGPT Plus or Pro plan, through Sign in with ChatGPT.
    public static let openAIChatGPT = PlanProvider(rawValue: "openai_chatgpt")

    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }
}

/// Which rail a request starts from.
public enum FundingPreference: Sendable, Equatable {
    /// Follow the feature's server-side chain (the default). A connected plan's credential is
    /// sent only to features whose catalog entry accepts that provider.
    case serverChain
    /// Start the chain at `rail` (`X-Weirgate-Funding`); later rails still apply. Starting at
    /// a rail after `user_plan` means the plan credential is not sent.
    case startAt(FundingRail, provider: PlanProvider? = nil)

    var headerValue: String? {
        switch self {
        case .serverChain: nil
        case .startAt(let rail, let provider):
            provider.map { "\(rail.rawValue); provider=\($0.rawValue)" } ?? rail.rawValue
        }
    }
}

/// What the server reported about who paid, from `X-Weirgate-Funding-Rail` and
/// `X-Weirgate-Funding-Fallback`.
public struct FundingOutcome: Sendable, Equatable {
    /// A rail that refused inside the request before a later rail paid.
    public struct Fallback: Sendable, Equatable {
        public let refusedRail: FundingRail
        /// The refusal code, for example `plan_limit_exceeded` or `user_not_eligible`.
        public let reason: String?
        /// The feature's `on_refusal` is `next_and_disable`: stop offering ``refusedRail``
        /// until the user re-consents. The SDK already disconnected a plan when this is set.
        public let disable: Bool

        public init(refusedRail: FundingRail, reason: String?, disable: Bool) {
            self.refusedRail = refusedRail
            self.reason = reason
            self.disable = disable
        }
    }

    /// The rail that paid. `nil` only when the server sent no rail header (an older server).
    public let rail: FundingRail?
    public let provider: PlanProvider?
    public let fallback: Fallback?

    public init(rail: FundingRail?, provider: PlanProvider? = nil, fallback: Fallback? = nil) {
        self.rail = rail
        self.provider = provider
        self.fallback = fallback
    }

    /// Parses the two response headers. Returns `nil` when neither is present.
    public init?(railHeader: String?, fallbackHeader: String?) {
        guard railHeader != nil || fallbackHeader != nil else { return nil }
        let paid = railHeader.map(Self.parameters)
        rail = paid?.head.map(FundingRail.init(rawValue:))
        provider = paid?.values["provider"].map(PlanProvider.init(rawValue:))
        fallback = fallbackHeader.map(Self.parameters).flatMap { parsed in
            parsed.head.map {
                Fallback(refusedRail: FundingRail(rawValue: $0), reason: parsed.values["reason"], disable: parsed.flags.contains("disable"))
            }
        }
    }

    /// `head; key=value; flag` → head, key/values, bare flags.
    static func parameters(_ header: String) -> (head: String?, values: [String: String], flags: Set<String>) {
        let parts = header.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var values: [String: String] = [:]
        var flags: Set<String> = []
        for part in parts.dropFirst() {
            if let equals = part.firstIndex(of: "=") {
                values[String(part[..<equals]).lowercased()] = String(part[part.index(after: equals)...])
            } else {
                flags.insert(part.lowercased())
            }
        }
        return (parts.first, values, flags)
    }
}

/// Why a connected plan had to be cleared and the user asked to reconnect.
public enum PlanReconnectReason: Codable, Sendable, Equatable {
    /// Weirgate rejected a freshly refreshed credential (`user_credential_expired` twice,
    /// for example `subscription_sharing_invalid_user`): the user disconnected the app in
    /// their plan settings, or the account changed.
    case credentialRejected(providerCode: String?)
    /// The provider's token endpoint refused the refresh token (`invalid_grant`,
    /// `invalid_refresh_token`, `token_expired`, `refresh_token_reused`).
    case refreshRejected(oauthError: String)
    /// The server fell back past the plan with `disable` (`on_refusal: next_and_disable`,
    /// typically `user_not_eligible`). Offer the plan again only after the user re-consents.
    case railDisabled(reason: String?)
}

/// The outcome of ``PlanCredentialSource/refreshAccessToken(rejected:)``.
public enum PlanRefreshResult: Sendable, Equatable {
    case refreshed(String)
    case reconnectRequired(PlanReconnectReason)
}

/// A source of the end user's plan credential for the `user_plan` rail. ``PlanConnect``
/// implements it on iOS and macOS; supply your own to keep tokens in another store.
///
/// The credential is sent to Weirgate per request and never persisted by ``WeirgateClient``.
public protocol PlanCredentialSource: Sendable {
    var provider: PlanProvider { get }
    /// The access token to send now, refreshed first when it expires within five minutes;
    /// `nil` when the plan is not connected or the user did not grant plan usage.
    func fundingAccessToken() async throws -> String?
    /// Weirgate rejected `rejected` with `user_credential_expired`. Refresh once (unless
    /// another caller already replaced that token) and return the new token. When the
    /// provider refuses the refresh, clear the tokens and return `.reconnectRequired`.
    /// Throw only for transient failures (network, 5xx); the tokens stay.
    func refreshAccessToken(rejected: String) async throws -> PlanRefreshResult
    /// Clear the stored tokens and report that the user must reconnect.
    func requireReconnect(_ reason: PlanReconnectReason) async
}

/// A `funding_rail_refused`, `funding_rail_unavailable`, or `user_credential_expired`
/// error, or a plan that must be reconnected. Thrown by chat and streaming calls, before
/// headers or as the stream's final error frame.
public struct FundingRailError: LocalizedError, WeirgateCorrelatedError, Sendable {
    public enum Code: Sendable, Equatable {
        /// `funding_rail_refused` (402): the rail cannot pay and the chain stopped or ended.
        /// When ``FundingRailError/nextRail`` is set the SDK already retried there once
        /// before headers; mid-stream, restart with ``FundingRailError/retryOptions(from:)``.
        case railRefused
        /// `funding_rail_unavailable` (403): not approved for live traffic, not accepted by
        /// the feature, or rejected by the provider. Fix configuration; do not retry.
        case railUnavailable
        /// `user_credential_expired` (401) that the SDK could not recover by refreshing,
        /// because no ``PlanCredentialSource`` was configured.
        case credentialExpired
        /// The plan's tokens were cleared. Show "Reconnect" (for ChatGPT, "Continue with
        /// ChatGPT" again). The same request can be retried now; it uses the next rail.
        case reconnectRequired(PlanReconnectReason)
    }

    public let code: Code
    /// The server error this came from; `nil` for a refresh refused by the provider.
    public let underlying: WeirgateError?
    /// The idempotency key the failed attempt used.
    public let idempotencyKey: String?
    let fallbackRequestID: String

    public var rail: FundingRail? { underlying?.stringDetail("rail").map(FundingRail.init(rawValue:)) }
    public var provider: PlanProvider? { underlying?.stringDetail("provider").map(PlanProvider.init(rawValue:)) }
    /// `detail.reason`: `plan_limit_exceeded`, `user_not_eligible`, `usage_unavailable`,
    /// `unsupported_capability`, `not_connected`, `credential_expired`,
    /// `provider_not_approved`, `provider_not_accepted`, `provider_rejected_route`, ...
    public var reason: String? { underlying?.reason }
    public var nextRail: FundingRail? { underlying?.stringDetail("next_rail").map(FundingRail.init(rawValue:)) }
    /// `detail.disable` on a mid-stream refusal (`on_refusal: next_and_disable`): stop offering
    /// ``rail`` until the user re-consents. For a plan the SDK sent, it already disconnected it.
    public var disablesRail: Bool {
        if case .bool(true) = underlying?.detail?["disable"] { return true }
        return false
    }
    /// The plan provider's request ID; keep it for support, as OpenAI's recovery guide asks.
    public var providerRequestID: String? { underlying?.stringDetail("provider_request_id") }
    public var providerCode: String? { underlying?.stringDetail("provider_code") }
    public var requestID: String { underlying?.requestID ?? fallbackRequestID }
    public var apiVersion: String { underlying?.apiVersion ?? WeirgateKitInfo.apiVersion }

    public var isReconnectRequired: Bool {
        if case .reconnectRequired = code { return true }
        return false
    }

    /// Options to restart a request on ``nextRail``: same per-call settings, the rail as the
    /// starting point, and the idempotency key the server uses for that rail. `nil` when
    /// there is no next rail.
    public func retryOptions(from options: RequestOptions = .init()) -> RequestOptions? {
        guard let nextRail else { return nil }
        return RequestOptions(
            idempotencyKey: (idempotencyKey ?? options.idempotencyKey).map { "\($0):rail:\(nextRail.rawValue)" },
            userProviderKey: options.userProviderKey,
            funding: .startAt(nextRail)
        )
    }

    public var errorDescription: String? {
        switch code {
        case .railRefused: "This request's funding source refused it (\(reason ?? "refused"))."
        case .railUnavailable: "This funding source is not available for this app."
        case .credentialExpired: "The plan credential expired."
        case .reconnectRequired: "Reconnect your plan to keep using it in this app."
        }
    }

    init(code: Code, underlying: WeirgateError?, idempotencyKey: String?, requestID: String = "unavailable") {
        self.code = code
        self.underlying = underlying
        self.idempotencyKey = idempotencyKey
        self.fallbackRequestID = requestID
    }

    init?(_ error: WeirgateError, idempotencyKey: String?) {
        switch error.type {
        case .fundingRailRefused: code = .railRefused
        case .fundingRailUnavailable: code = .railUnavailable
        case .userCredentialExpired: code = .credentialExpired
        default: return nil
        }
        underlying = error
        self.idempotencyKey = idempotencyKey
        fallbackRequestID = error.requestID
    }
}

extension WeirgateError {
    func stringDetail(_ key: String) -> String? {
        if case .string(let value) = detail?[key] { return value }
        return nil
    }
}

extension Feature {
    /// The feature's funding chain from the catalog.
    public struct Funding: Codable, Hashable, Sendable {
        public let order: [FundingRail]
        /// Plan providers the `user_plan` rail accepts; empty when the chain has no plan rail.
        public let planProviders: [PlanProvider]

        public init(order: [FundingRail], planProviders: [PlanProvider]) {
            self.order = order
            self.planProviders = planProviders
        }

        enum CodingKeys: String, CodingKey {
            case order
            case planProviders = "plan_providers"
        }
    }

    /// True when this feature can be paid by the user's `provider` plan, so the app may offer
    /// that provider's button (for ChatGPT, "Continue with ChatGPT") next to it.
    public func acceptsPlan(_ provider: PlanProvider) -> Bool {
        guard let funding else { return false }
        return funding.order.contains(.userPlan) && funding.planProviders.contains(provider)
    }
}

extension FeatureCatalog {
    /// Available features the user's `provider` plan can pay for.
    public func features(acceptingPlan provider: PlanProvider) -> [Feature] {
        data.filter { $0.availability.available && $0.acceptsPlan(provider) }
    }

    /// True when at least one available feature accepts `provider`: show the connect
    /// button (it must stay optional; see the README).
    public func offersPlan(_ provider: PlanProvider) -> Bool {
        !features(acceptingPlan: provider).isEmpty
    }
}

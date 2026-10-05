import Foundation

public struct Health: Codable, Sendable, Equatable {
    public let ok: Bool
    public let mode: String
}

public struct ChatMessage: Codable, Sendable, Equatable {
    public let role: String
    public let content: JSONValue

    public init(role: String, content: JSONValue) {
        self.role = role
        self.content = content
    }

    public static func text(role: String, content: String) -> ChatMessage {
        ChatMessage(role: role, content: .string(content))
    }
}

public struct ChatCompletionRequest: Encodable, Sendable {
    public let messages: [ChatMessage]
    public let temperature: Double?
    public let metadata: [String: String]?

    public init(
        messages: [ChatMessage],
        temperature: Double? = nil,
        metadata: [String: String]? = nil
    ) {
        self.messages = messages
        self.temperature = temperature
        self.metadata = metadata
    }

    enum CodingKeys: String, CodingKey { case messages, temperature, metadata, stream }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(messages, forKey: .messages)
        try container.encodeIfPresent(temperature, forKey: .temperature)
        try container.encodeIfPresent(metadata, forKey: .metadata)
    }
}

struct StreamingChatRequest: Encodable {
    let request: ChatCompletionRequest

    func encode(to encoder: Encoder) throws {
        try request.encode(to: encoder)
        var container = encoder.container(keyedBy: ChatCompletionRequest.CodingKeys.self)
        try container.encode(true, forKey: .stream)
    }
}

public struct TokenUsage: Codable, Sendable, Equatable {
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let cost: Double?
    public let model: String?

    enum CodingKeys: String, CodingKey {
        case cost, model
        case promptTokens = "prompt_tokens"
        case completionTokens = "completion_tokens"
        case totalTokens = "total_tokens"
    }
}

public struct ChatCompletion: Codable, Sendable {
    public let id: String
    public let object: String
    public let model: String?
    public let choices: [JSONValue]
    public let usage: TokenUsage?
}

public struct ChatCompletionChunk: Codable, Sendable {
    public struct Choice: Codable, Sendable {
        public struct Delta: Codable, Sendable {
            public let role: String?
            public let content: String?
        }

        public let index: Int?
        public let delta: Delta?
        public let finishReason: String?

        enum CodingKeys: String, CodingKey {
            case index, delta
            case finishReason = "finish_reason"
        }
    }

    public let id: String
    public let object: String
    public let model: String?
    public let choices: [Choice]
    public let usage: TokenUsage?
}

public struct FeatureCatalog: Codable, Sendable {
    public let catalogVersion: String
    public let data: [Feature]

    enum CodingKeys: String, CodingKey {
        case data
        case catalogVersion = "catalog_version"
    }
}

public struct Feature: Codable, Identifiable, Hashable, Sendable {
    public enum Modality: String, Codable, Sendable { case chat, embedding, image, audio }
    public enum KeyPolicy: String, Codable, Sendable {
        case developer, user
        case userOrDeveloper = "user_or_developer"
    }
    public enum Provider: String, Codable, Sendable { case openrouter, openai, anthropic, google, xai }
    public enum ProviderState: String, Codable, Sendable { case allowed, warning, blocked }

    public struct Availability: Codable, Hashable, Sendable {
        public let available: Bool
        public let reason: String?
    }

    public struct ProviderPolicy: Codable, Hashable, Sendable {
        public let effectiveState: ProviderState
        enum CodingKeys: String, CodingKey { case effectiveState = "effective_state" }
    }

    public let featureID: String
    public let modality: Modality
    public let keyPolicy: KeyPolicy
    public let displayLabel: String
    public let availability: Availability
    public let providerPolicy: ProviderPolicy
    public let provider: Provider?
    public let model: String?
    /// The funding chain; `nil` from a server that predates funding rails.
    public let funding: Funding?

    public var id: String { featureID }

    enum CodingKeys: String, CodingKey {
        case modality, availability, provider, model, funding
        case featureID = "feature_id"
        case keyPolicy = "key_policy"
        case displayLabel = "display_label"
        case providerPolicy = "provider_policy"
    }
}

public struct Balance: Codable, Sendable, Equatable {
    public let unitsAvailable: Double
    public let unitsPending: Double
    public let tier: String
    /// True while the active tier is unlimited: metered requests skip the balance check
    /// and debit zero units. `unitsAvailable` still reports the real balance.
    public let unlimited: Bool
    /// When the unlimited assignment ends; `nil` when not unlimited or open-ended.
    public let unlimitedUntil: Date?
    /// Stable per-user-row UUID. Pass it to StoreKit 2 as
    /// `Product.PurchaseOption.appAccountToken(_:)` so Weirgate can tie each purchase to
    /// this user. A new user row (an anonymous user after reinstall, or after account
    /// deletion) has a new token.
    public let appAccountToken: UUID
    /// Unspent monthly allowance of a plan whose allowance resets each UTC month
    /// (`allowance_rollover: expire`). Never negative; 0 on plans whose allowance carries over.
    /// Spent first. `allowanceAvailable + purchasedAvailable == unitsAvailable`.
    public let allowanceAvailable: Double
    /// Everything that never expires: purchased credit packs, welcome and manual grants,
    /// carried-over allowance, and adjustments. Can be negative after a refund or clawback.
    public let purchasedAvailable: Double

    public init(
        unitsAvailable: Double,
        unitsPending: Double,
        tier: String,
        unlimited: Bool = false,
        unlimitedUntil: Date? = nil,
        appAccountToken: UUID,
        allowanceAvailable: Double = 0,
        purchasedAvailable: Double? = nil
    ) {
        self.unitsAvailable = unitsAvailable
        self.unitsPending = unitsPending
        self.tier = tier
        self.unlimited = unlimited
        self.unlimitedUntil = unlimitedUntil
        self.appAccountToken = appAccountToken
        self.allowanceAvailable = allowanceAvailable
        self.purchasedAvailable = purchasedAvailable ?? unitsAvailable - allowanceAvailable
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unitsAvailable = try container.decode(Double.self, forKey: .unitsAvailable)
        unitsPending = try container.decode(Double.self, forKey: .unitsPending)
        tier = try container.decode(String.self, forKey: .tier)
        unlimited = try container.decode(Bool.self, forKey: .unlimited)
        unlimitedUntil = try container.decodeIfPresent(String.self, forKey: .unlimitedUntil)
            .map { try WeirgateTimestamp.date(from: $0, codingPath: container.codingPath + [CodingKeys.unlimitedUntil]) }
        appAccountToken = try container.decode(UUID.self, forKey: .appAccountToken)
        allowanceAvailable = try container.decodeIfPresent(Double.self, forKey: .allowanceAvailable) ?? 0
        purchasedAvailable = try container.decodeIfPresent(Double.self, forKey: .purchasedAvailable)
            ?? unitsAvailable - allowanceAvailable
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(unitsAvailable, forKey: .unitsAvailable)
        try container.encode(unitsPending, forKey: .unitsPending)
        try container.encode(tier, forKey: .tier)
        try container.encode(unlimited, forKey: .unlimited)
        try container.encode(unlimitedUntil.map(WeirgateTimestamp.string(from:)), forKey: .unlimitedUntil)
        try container.encode(appAccountToken, forKey: .appAccountToken)
        try container.encode(allowanceAvailable, forKey: .allowanceAvailable)
        try container.encode(purchasedAvailable, forKey: .purchasedAvailable)
    }

    enum CodingKeys: String, CodingKey {
        case tier, unlimited
        case unitsAvailable = "units_available"
        case unitsPending = "units_pending"
        case unlimitedUntil = "unlimited_until"
        case appAccountToken = "app_account_token"
        case allowanceAvailable = "allowance_available"
        case purchasedAvailable = "purchased_available"
    }
}

/// RFC 3339 timestamps as Weirgate sends them, with or without fractional seconds.
enum WeirgateTimestamp {
    static func date(from value: String, codingPath: [CodingKey]) throws -> Date {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) {
            return date
        }
        if let date = try? Date.ISO8601FormatStyle().parse(value) {
            return date
        }
        throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Expected an RFC 3339 timestamp"))
    }

    static func string(from date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}

/// Result of ``WeirgateClient/claimWelcomeCredits(appleIdentityToken:maxAttempts:)``.
/// Every outcome is an HTTP 200; switch on ``status``.
public struct WelcomeCreditsClaim: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable, Equatable {
        /// Credits were added. ``WelcomeCreditsClaim/idempotent`` is true when this user
        /// had already claimed them (a replay).
        case granted
        /// This Apple account already claimed on another app user (including a deleted
        /// one), or this user already received a welcome grant. Stop offering the credits.
        case alreadyClaimed = "already_claimed"
        /// No verified identity was supplied. Offer Sign in with Apple.
        case requiresSignIn = "welcome_requires_sign_in"
    }

    public let status: Status
    /// Units granted by this claim; 0 unless `status` is `granted`.
    public let units: Double
    /// Present when `status` is `granted`.
    public let grantID: String?
    public let idempotent: Bool
    public let unitsAvailable: Double
    public let unitsPending: Double

    public init(
        status: Status,
        units: Double,
        grantID: String? = nil,
        idempotent: Bool = false,
        unitsAvailable: Double,
        unitsPending: Double = 0
    ) {
        self.status = status
        self.units = units
        self.grantID = grantID
        self.idempotent = idempotent
        self.unitsAvailable = unitsAvailable
        self.unitsPending = unitsPending
    }

    enum CodingKeys: String, CodingKey {
        case status, units, idempotent
        case grantID = "grant_id"
        case unitsAvailable = "units_available"
        case unitsPending = "units_pending"
    }
}

/// Result of ``WeirgateClient/redeemAppStoreTransaction(jws:)``. Finish the StoreKit
/// transaction after receiving this value (either status).
public struct PurchaseRedemption: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable, Equatable {
        /// This call credited the caller (consumable), or recorded the subscription period for
        /// the caller (subscription).
        case granted
        /// The transaction was handled earlier (by an earlier call or an App Store
        /// notification). For a consumable, ``PurchaseRedemption/units`` is what the caller
        /// received from it. Also returned for older subscription periods.
        case alreadyGranted = "already_granted"
    }

    public enum Kind: String, Codable, Sendable, Equatable {
        /// A Consumable product: credits.
        case consumable
        /// An Auto-Renewable Subscription product: a plan while the subscription is active.
        case subscription
    }

    /// The subscription a redeemed Auto-Renewable Subscription transaction belongs to.
    public struct Subscription: Codable, Sendable, Equatable {
        public enum Status: String, Codable, Sendable, Equatable {
            case active, expired, revoked, refunded
        }

        /// The plan the product maps to; `nil` if it is no longer configured.
        public let tier: String?
        public let status: Status
        /// When the plan ends: the period end, or the billing grace period end if later.
        public let expiresAt: Date
        /// True while the subscription entitles the user to its plan.
        public let active: Bool
        /// False when a higher-ranked plan assigned by the developer is in effect; the
        /// subscription's plan applies when that ends.
        public let planApplied: Bool

        public init(tier: String?, status: Status, expiresAt: Date, active: Bool, planApplied: Bool) {
            self.tier = tier
            self.status = status
            self.expiresAt = expiresAt
            self.active = active
            self.planApplied = planApplied
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            tier = try container.decodeIfPresent(String.self, forKey: .tier)
            status = try container.decode(Status.self, forKey: .status)
            expiresAt = try WeirgateTimestamp.date(
                from: try container.decode(String.self, forKey: .expiresAt),
                codingPath: container.codingPath + [CodingKeys.expiresAt]
            )
            active = try container.decode(Bool.self, forKey: .active)
            planApplied = try container.decode(Bool.self, forKey: .planApplied)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(tier, forKey: .tier)
            try container.encode(status, forKey: .status)
            try container.encode(WeirgateTimestamp.string(from: expiresAt), forKey: .expiresAt)
            try container.encode(active, forKey: .active)
            try container.encode(planApplied, forKey: .planApplied)
        }

        enum CodingKeys: String, CodingKey {
            case tier, status, active
            case expiresAt = "expires_at"
            case planApplied = "plan_applied"
        }
    }

    public enum Environment: String, Codable, Sendable, Equatable {
        /// Apple sandbox (Xcode device builds, TestFlight, App Review).
        case test
        /// App Store production.
        case live
    }

    public let status: Status
    /// Units the caller received from this transaction; 0 when another user redeemed a
    /// record without an `appAccountToken` first.
    public let units: Double
    /// Absent when another user redeemed the transaction first.
    public let grantID: String?
    public let transactionID: String
    public let productID: String
    public let environment: Environment
    public let unitsAvailable: Double
    public let unitsPending: Double
    /// `.consumable` unless the product is configured as a subscription.
    public let kind: Kind
    /// Subscriptions only.
    public let originalTransactionID: String?
    /// Subscriptions only: the caller's tier after the redeem.
    public let tier: String?
    /// Subscriptions only; `nil` for consumables and when another user of the app owns the
    /// subscription.
    public let subscription: Subscription?

    public init(
        status: Status,
        units: Double,
        grantID: String? = nil,
        transactionID: String,
        productID: String,
        environment: Environment,
        unitsAvailable: Double,
        unitsPending: Double = 0,
        kind: Kind = .consumable,
        originalTransactionID: String? = nil,
        tier: String? = nil,
        subscription: Subscription? = nil
    ) {
        self.status = status
        self.units = units
        self.grantID = grantID
        self.transactionID = transactionID
        self.productID = productID
        self.environment = environment
        self.unitsAvailable = unitsAvailable
        self.unitsPending = unitsPending
        self.kind = kind
        self.originalTransactionID = originalTransactionID
        self.tier = tier
        self.subscription = subscription
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(Status.self, forKey: .status)
        units = try container.decode(Double.self, forKey: .units)
        grantID = try container.decodeIfPresent(String.self, forKey: .grantID)
        transactionID = try container.decode(String.self, forKey: .transactionID)
        productID = try container.decode(String.self, forKey: .productID)
        environment = try container.decode(Environment.self, forKey: .environment)
        unitsAvailable = try container.decode(Double.self, forKey: .unitsAvailable)
        unitsPending = try container.decode(Double.self, forKey: .unitsPending)
        kind = try container.decodeIfPresent(Kind.self, forKey: .kind) ?? .consumable
        originalTransactionID = try container.decodeIfPresent(String.self, forKey: .originalTransactionID)
        tier = try container.decodeIfPresent(String.self, forKey: .tier)
        subscription = try container.decodeIfPresent(Subscription.self, forKey: .subscription)
    }

    enum CodingKeys: String, CodingKey {
        case status, units, environment, kind, tier, subscription
        case grantID = "grant_id"
        case transactionID = "transaction_id"
        case productID = "product_id"
        case unitsAvailable = "units_available"
        case unitsPending = "units_pending"
        case originalTransactionID = "original_transaction_id"
    }
}

struct WelcomeCreditsInput: Encodable {
    let appleIdentityToken: String?

    enum CodingKeys: String, CodingKey {
        case appleIdentityToken = "apple_identity_token"
    }
}

struct AppStoreRedeemInput: Encodable {
    let signedTransaction: String

    enum CodingKeys: String, CodingKey {
        case signedTransaction = "signed_transaction"
    }
}

public struct AccountDeletionResult: Codable, Sendable, Equatable {
    public let deleted: Bool
    public let idempotent: Bool
    public let userID: String?
    public let anonymizedAt: String?

    enum CodingKeys: String, CodingKey {
        case deleted, idempotent
        case userID = "user_id"
        case anonymizedAt = "anonymized_at"
    }
}

public struct ClientTelemetry: Codable, Sendable {
    public struct SDK: Codable, Sendable {
        public let name: String
        public let version: String

        public init(name: String, version: String) {
            self.name = name
            self.version = version
        }
    }

    public let requestID: String
    public let eventID: String
    public let eventType: String
    public let ttftMilliseconds: Int
    public let contentCompleteMilliseconds: Int?
    public let sdk: SDK

    public init(
        requestID: String,
        eventID: String = "evt_\(UUID().uuidString)",
        ttftMilliseconds: Int,
        contentCompleteMilliseconds: Int? = nil,
        sdk: SDK = .init(name: "WeirgateKit", version: WeirgateKitInfo.version)
    ) {
        self.requestID = requestID
        self.eventID = eventID
        self.eventType = "timing"
        self.ttftMilliseconds = ttftMilliseconds
        self.contentCompleteMilliseconds = contentCompleteMilliseconds
        self.sdk = sdk
    }

    enum CodingKeys: String, CodingKey {
        case sdk
        case requestID = "request_id"
        case eventID = "event_id"
        case eventType = "event_type"
        case ttftMilliseconds = "ttft_ms"
        case contentCompleteMilliseconds = "content_complete_ms"
    }
}

public struct Accepted: Codable, Sendable, Equatable {
    public let accepted: Bool
}

public struct OutputContract: Codable, Sendable, Equatable {
    public enum UnsupportedReasoning: String, Codable, Sendable { case fail, useCompatibleRoute = "use_compatible_route" }
    public struct Reasoning: Codable, Sendable, Equatable {
        public let mode: String
        public let maxTokens: Int?
        enum CodingKeys: String, CodingKey { case mode; case maxTokens = "max_tokens" }
    }

    public let maxVisibleOutputTokens: Int
    public let minVisibleOutputTokens: Int?
    public let reasoning: Reasoning?
    public let acceptedFinishReasons: [String]?
    public let onUnsupportedReasoning: UnsupportedReasoning?

    enum CodingKeys: String, CodingKey {
        case reasoning
        case maxVisibleOutputTokens = "max_visible_output_tokens"
        case minVisibleOutputTokens = "min_visible_output_tokens"
        case acceptedFinishReasons = "accepted_finish_reasons"
        case onUnsupportedReasoning = "on_unsupported_reasoning"
    }
}

public enum CatalogResult: Sendable {
    case modified(WeirgateResponse<FeatureCatalog>, etag: String?)
    case notModified(metadata: ResponseMetadata, etag: String?)
}

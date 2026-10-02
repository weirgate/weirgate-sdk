import Foundation

public enum WeirgateErrorType: String, Codable, CaseIterable, Sendable {
    case invalidRequest = "invalid_request"
    case invalidToken = "invalid_token"
    case userProviderKeyRequired = "user_provider_key_required"
    case userProviderKeyInvalid = "user_provider_key_invalid"
    case insufficientScope = "insufficient_scope"
    case outOfAllowance = "out_of_allowance"
    case insufficientBalance = "insufficient_balance"
    case abuseBlocked = "abuse_blocked"
    case featureDisabled = "feature_disabled"
    case featureNotFound = "feature_not_found"
    case resourceNotFound = "resource_not_found"
    case resourceConflict = "resource_conflict"
    case providerPolicyBlocked = "provider_policy_blocked"
    case outputContractUnsupported = "output_contract_unsupported"
    case outputContractViolation = "output_contract_violation"
    case proposalStale = "proposal_stale"
    case rateLimited = "rate_limited"
    case telemetryRequestUnavailable = "telemetry_request_unavailable"
    case providerUnavailable = "provider_unavailable"
    case purchaseInvalidSignature = "purchase_invalid_signature"
    case purchaseWrongApp = "purchase_wrong_app"
    case purchaseEnvironmentMismatch = "purchase_environment_mismatch"
    case purchaseUnknownProduct = "purchase_unknown_product"
    case purchaseRevoked = "purchase_revoked"
    case purchaseAccountMismatch = "purchase_account_mismatch"
    case internalError = "internal"
}

public protocol WeirgateCorrelatedError: Error {
    var requestID: String { get }
    var apiVersion: String { get }
}

public struct WeirgateError: LocalizedError, WeirgateCorrelatedError, Sendable {
    public let type: WeirgateErrorType
    public let statusCode: Int
    public let requestID: String
    public let apiVersion: String
    public let serverMessage: String?
    public let detail: [String: JSONValue]?
    /// Seconds from the `Retry-After` header, when the server sent one.
    public internal(set) var retryAfter: TimeInterval? = nil

    /// `detail.reason`, the stable sub-code some errors carry (for example
    /// `apple_identity_token_invalid` or `payments_not_configured`).
    public var reason: String? {
        if case .string(let value) = detail?["reason"] { return value }
        return nil
    }

    public var errorDescription: String? {
        "Weirgate request failed with \(type.rawValue) (HTTP \(statusCode))."
    }
}

/// A typed failure of ``WeirgateClient/claimWelcomeCredits(appleIdentityToken:maxAttempts:)``.
/// Every other failure is thrown as ``WeirgateError`` or ``WeirgateSDKError``.
public struct WelcomeCreditsError: LocalizedError, WeirgateCorrelatedError, Sendable {
    public enum Code: Sendable, Equatable {
        /// The Apple identity token is invalid or expired
        /// (`invalid_request`, `detail.reason=apple_identity_token_invalid`). Get a fresh
        /// token from Sign in with Apple and claim again.
        case appleIdentityTokenInvalid
        /// Weirgate could not fetch Apple's signing keys (`provider_unavailable`,
        /// `detail.reason=apple_jwks_unavailable`). Nothing was granted; retry after
        /// ``WelcomeCreditsError/retryAfter``.
        case appleUnavailable
        /// The app has no `welcome_grant` config (`resource_not_found`,
        /// `detail.reason=welcome_grant_not_configured`).
        case notConfigured
    }

    public let code: Code
    /// The server error this was mapped from.
    public let underlying: WeirgateError

    public var retryAfter: TimeInterval? { underlying.retryAfter }
    public var isRetryable: Bool { code == .appleUnavailable }
    public var requestID: String { underlying.requestID }
    public var apiVersion: String { underlying.apiVersion }

    public var errorDescription: String? {
        switch code {
        case .appleIdentityTokenInvalid: "The Sign in with Apple token is invalid or expired."
        case .appleUnavailable: "Sign in with Apple is temporarily unavailable. Try again shortly."
        case .notConfigured: "Welcome credits are not configured for this app."
        }
    }

    init?(_ error: WeirgateError) {
        switch (error.type, error.reason) {
        case (.invalidRequest, "apple_identity_token_invalid"): code = .appleIdentityTokenInvalid
        case (.providerUnavailable, _): code = .appleUnavailable
        case (.resourceNotFound, "welcome_grant_not_configured"): code = .notConfigured
        default: return nil
        }
        underlying = error
    }
}

/// A typed rejection from ``WeirgateClient/redeemAppStoreTransaction(jws:)``. Every one of
/// these is permanent for that transaction: sending the same record again gives the same
/// answer until the app's config changes. Transport failures and 5xx responses are thrown
/// as ``WeirgateSDKError`` / ``WeirgateError`` instead, and are worth retrying.
public struct PurchaseRedemptionError: LocalizedError, WeirgateCorrelatedError, Sendable {
    public enum Code: String, Sendable, Equatable, CaseIterable {
        /// Apple's signature did not verify (`purchase_invalid_signature`, 400). Expected
        /// for transactions from an Xcode `.storekit` file, which Xcode signs locally.
        case invalidSignature = "purchase_invalid_signature"
        /// The record is for another bundle ID, or was recorded for another app (422).
        case wrongApp = "purchase_wrong_app"
        /// The record's environment (sandbox / production) is not allowed for this app,
        /// or does not match the key environment (422).
        case environmentMismatch = "purchase_environment_mismatch"
        /// The product is not mapped as a consumable in `payments.apple.products` (422).
        case unknownProduct = "purchase_unknown_product"
        /// The App Store refunded or revoked the transaction (409). Safe to finish.
        case revoked = "purchase_revoked"
        /// The record's `appAccountToken` belongs to another user row, or the app requires
        /// one and the record has none (403).
        case accountMismatch = "purchase_account_mismatch"
        /// The app has no `payments.apple` config (`resource_not_found`,
        /// `detail.reason=payments_not_configured`).
        case paymentsNotConfigured = "payments_not_configured"
    }

    public let code: Code
    /// The server error this was mapped from; `underlying.reason` names the failed check.
    public let underlying: WeirgateError

    public var reason: String? { underlying.reason }
    /// True only for ``Code/revoked``: the App Store refunded or revoked the purchase, so
    /// finishing the transaction is safe. Every other code leaves it unfinished.
    public var shouldFinishTransaction: Bool { code == .revoked }
    public var requestID: String { underlying.requestID }
    public var apiVersion: String { underlying.apiVersion }

    public var errorDescription: String? {
        "Weirgate did not credit this App Store purchase (\(code.rawValue))."
    }

    init?(_ error: WeirgateError) {
        if error.type == .resourceNotFound, error.reason == "payments_not_configured" {
            code = .paymentsNotConfigured
        } else if let mapped = Code(rawValue: error.type.rawValue) {
            code = mapped
        } else {
            return nil
        }
        underlying = error
    }
}

public enum WeirgateSDKError: LocalizedError, WeirgateCorrelatedError, Sendable {
    case invalidConfiguration(String)
    case transport(String)
    case invalidResponse(requestID: String, apiVersion: String, statusCode: Int)
    case invalidBody(requestID: String, apiVersion: String, statusCode: Int)
    case invalidStream(requestID: String, apiVersion: String, reason: String)
    case interruptedStream(requestID: String, apiVersion: String)

    public var requestID: String {
        switch self {
        case .invalidConfiguration, .transport: "unavailable"
        case .invalidResponse(let value, _, _), .invalidBody(let value, _, _),
             .invalidStream(let value, _, _), .interruptedStream(let value, _): value
        }
    }

    public var apiVersion: String {
        switch self {
        case .invalidConfiguration, .transport: WeirgateKitInfo.apiVersion
        case .invalidResponse(_, let value, _), .invalidBody(_, let value, _),
             .invalidStream(_, let value, _), .interruptedStream(_, let value): value
        }
    }

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let message): message
        case .transport: "The Weirgate API could not be reached."
        case .invalidResponse: "Weirgate returned an invalid response."
        case .invalidBody: "Weirgate returned an invalid response body."
        case .invalidStream(_, _, let reason): "Weirgate returned an invalid stream: \(reason)."
        case .interruptedStream: "Weirgate streaming ended before final usage and completion."
        }
    }
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let type: WeirgateErrorType
        let message: String
        let requestID: String
        let detail: [String: JSONValue]?

        enum CodingKeys: String, CodingKey {
            case type, message, detail
            case requestID = "request_id"
        }
    }

    let error: Body
}

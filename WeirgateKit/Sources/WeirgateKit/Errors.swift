import Foundation

public enum WeirgateErrorType: String, Codable, CaseIterable, Sendable {
    case invalidRequest = "invalid_request"
    case invalidToken = "invalid_token"
    case userProviderKeyRequired = "user_provider_key_required"
    case userProviderKeyInvalid = "user_provider_key_invalid"
    case insufficientScope = "insufficient_scope"
    case outOfAllowance = "out_of_allowance"
    case abuseBlocked = "abuse_blocked"
    case featureDisabled = "feature_disabled"
    case featureNotFound = "feature_not_found"
    case resourceNotFound = "resource_not_found"
    case providerPolicyBlocked = "provider_policy_blocked"
    case outputContractUnsupported = "output_contract_unsupported"
    case outputContractViolation = "output_contract_violation"
    case proposalStale = "proposal_stale"
    case rateLimited = "rate_limited"
    case telemetryRequestUnavailable = "telemetry_request_unavailable"
    case providerUnavailable = "provider_unavailable"
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

    public var errorDescription: String? {
        "Weirgate request failed with \(type.rawValue) (HTTP \(statusCode))."
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

import Foundation

public enum WeirgateKitInfo {
    public static let version = "0.5.0"
    public static let apiVersion = "2026-07-18"
    public static let specSourceCommit = "91580ca0c2c6ca49df1a43628f474c892c8d6c97"
}

public struct WeirgateTokenProvider: Sendable {
    private let resolve: @Sendable () async throws -> String

    public init(_ resolve: @escaping @Sendable () async throws -> String) {
        self.resolve = resolve
    }

    func token() async throws -> String {
        try await resolve()
    }
}

public struct UserProviderKey: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    let value: String

    public init(_ value: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw WeirgateSDKError.invalidConfiguration("User provider key cannot be empty")
        }
        self.value = value
    }

    public var description: String { "<redacted>" }
    public var debugDescription: String { "UserProviderKey(<redacted>)" }
}

public struct WeirgateConfiguration: Sendable {
    public let baseURL: URL
    public let appID: String
    public let automaticallySubmitTelemetry: Bool
    /// The default starting rail for chat requests; per-call ``RequestOptions/funding``
    /// overrides it.
    public let fundingPreference: FundingPreference

    public init(
        baseURL: URL = URL(string: "https://api.weirgate.com")!,
        appID: String,
        automaticallySubmitTelemetry: Bool = true,
        fundingPreference: FundingPreference = .serverChain
    ) {
        self.baseURL = baseURL
        self.appID = appID
        self.automaticallySubmitTelemetry = automaticallySubmitTelemetry
        self.fundingPreference = fundingPreference
    }
}

public struct RequestOptions: Sendable {
    public let idempotencyKey: String?
    public let userProviderKey: UserProviderKey?
    /// Overrides ``WeirgateConfiguration/fundingPreference`` for this call.
    public let funding: FundingPreference?

    public init(
        idempotencyKey: String? = nil,
        userProviderKey: UserProviderKey? = nil,
        funding: FundingPreference? = nil
    ) {
        self.idempotencyKey = idempotencyKey
        self.userProviderKey = userProviderKey
        self.funding = funding
    }
}

public struct ResponseMetadata: Sendable, Equatable {
    public let requestID: String
    public let apiVersion: String
    public let statusCode: Int
    /// Who paid for a chat request, from the funding response headers; `nil` elsewhere.
    public let funding: FundingOutcome?

    public init(requestID: String, apiVersion: String, statusCode: Int, funding: FundingOutcome? = nil) {
        self.requestID = requestID
        self.apiVersion = apiVersion
        self.statusCode = statusCode
        self.funding = funding
    }
}

public struct WeirgateResponse<Value: Sendable>: Sendable {
    public let value: Value
    public let metadata: ResponseMetadata

    public init(value: Value, metadata: ResponseMetadata) {
        self.value = value
        self.metadata = metadata
    }
}

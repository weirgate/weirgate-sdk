import Foundation

public enum WeirgateKitInfo {
    public static let version = "0.1.0"
    public static let apiVersion = "2026-07-18"
    public static let specSourceCommit = "69a4e6b2f081ff9c7afd8cdc12618f9e2bd84a82"
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

    public init(
        baseURL: URL = URL(string: "https://api.weirgate.com")!,
        appID: String,
        automaticallySubmitTelemetry: Bool = true
    ) {
        self.baseURL = baseURL
        self.appID = appID
        self.automaticallySubmitTelemetry = automaticallySubmitTelemetry
    }
}

public struct RequestOptions: Sendable {
    public let idempotencyKey: String?
    public let userProviderKey: UserProviderKey?

    public init(idempotencyKey: String? = nil, userProviderKey: UserProviderKey? = nil) {
        self.idempotencyKey = idempotencyKey
        self.userProviderKey = userProviderKey
    }
}

public struct ResponseMetadata: Sendable, Equatable {
    public let requestID: String
    public let apiVersion: String
    public let statusCode: Int

    public init(requestID: String, apiVersion: String, statusCode: Int) {
        self.requestID = requestID
        self.apiVersion = apiVersion
        self.statusCode = statusCode
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

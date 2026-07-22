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

    public var id: String { featureID }

    enum CodingKeys: String, CodingKey {
        case modality, availability, provider, model
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

    enum CodingKeys: String, CodingKey {
        case tier
        case unitsAvailable = "units_available"
        case unitsPending = "units_pending"
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

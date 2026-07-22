import Foundation

public actor StreamTiming {
    public struct Snapshot: Sendable, Equatable {
        public let ttftMilliseconds: Int?
        public let contentCompleteMilliseconds: Int?
    }

    private let startedAt = ProcessInfo.processInfo.systemUptime
    private var firstTokenAt: TimeInterval?
    private var completedAt: TimeInterval?

    func recordContent() {
        if firstTokenAt == nil { firstTokenAt = ProcessInfo.processInfo.systemUptime }
    }

    func recordCompletion() {
        completedAt = ProcessInfo.processInfo.systemUptime
    }

    public func snapshot() -> Snapshot {
        Snapshot(
            ttftMilliseconds: firstTokenAt.map { Int(($0 - startedAt) * 1_000) },
            contentCompleteMilliseconds: completedAt.map { Int(($0 - startedAt) * 1_000) }
        )
    }
}

public struct ChatStream: Sendable {
    public let metadata: ResponseMetadata
    public let creditsRemaining: Double?
    public let chunks: AsyncThrowingStream<ChatCompletionChunk, Error>
    public let timing: StreamTiming
}

struct SSEContractAccumulator {
    private(set) var sawDone = false
    private(set) var sawUsage = false
    private(set) var sawFinishReason = false

    mutating func consume(line: String, decoder: JSONDecoder) throws -> ChatCompletionChunk? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return nil }
        let payload = trimmed.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" {
            sawDone = true
            return nil
        }
        guard let data = payload.data(using: .utf8) else { throw ParsingError.invalidUTF8 }
        let chunk = try decoder.decode(ChatCompletionChunk.self, from: data)
        if chunk.usage != nil { sawUsage = true }
        if chunk.choices.contains(where: { $0.finishReason != nil }) { sawFinishReason = true }
        return chunk
    }

    func validate() throws {
        guard sawDone, sawUsage, sawFinishReason else { throw ParsingError.interrupted }
    }

    enum ParsingError: Error { case invalidUTF8, interrupted }
}

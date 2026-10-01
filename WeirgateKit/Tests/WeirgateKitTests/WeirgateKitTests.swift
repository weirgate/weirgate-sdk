import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import WeirgateKit

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Test("mixed catalog accepts capability-only entries with no model")
func mixedCatalogDecode() throws {
    let data = Data(#"""
    {
      "catalog_version": "cat_1_0123456789abcdef",
      "data": [
        {
          "feature_id": "coach-chat",
          "modality": "chat",
          "key_policy": "developer",
          "display_label": "WyVo AI",
          "availability": {"available": true, "reason": null},
          "provider_policy": {"effective_state": "allowed"}
        },
        {
          "feature_id": "coach-chat-openai-gpt",
          "modality": "chat",
          "key_policy": "user",
          "display_label": "GPT",
          "availability": {"available": true, "reason": null},
          "provider_policy": {"effective_state": "allowed"},
          "provider": "openai",
          "model": "gpt"
        }
      ]
    }
    """#.utf8)

    let catalog = try JSONDecoder().decode(FeatureCatalog.self, from: data)
    #expect(catalog.data.count == 2)
    #expect(catalog.data[0].featureID == "coach-chat")
    #expect(catalog.data[0].model == nil)
    #expect(catalog.data[1].model == "gpt")
}

@Test("account deletion uses only the end-user token and app ID")
func accountDeletionRequest() async throws {
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: sessionConfiguration)
    StubURLProtocol.handler = { request in
        #expect(request.url?.path == "/v1/account")
        #expect(request.httpMethod == "DELETE")
        #expect(request.httpBody == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-jwt")
        #expect(request.value(forHTTPHeaderField: "X-App-Id") == "wyvo")
        #expect(request.value(forHTTPHeaderField: "X-Admin-Key") == nil)
        #expect(request.value(forHTTPHeaderField: "X-Idempotency-Key") != nil)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [
                "Content-Type": "application/json",
                "Weirgate-Api-Version": "2026-07-18",
                "X-Weirgate-Request-Id": "req_account_delete",
            ]
        )!
        let data = Data(#"{"deleted":true,"idempotent":false,"user_id":"internal-user","anonymized_at":"2026-08-16T18:00:00.000Z"}"#.utf8)
        return (response, data)
    }
    defer {
        StubURLProtocol.handler = nil
        session.invalidateAndCancel()
    }

    let client = WeirgateClient(
        configuration: .init(baseURL: URL(string: "https://api.example.test")!, appID: "wyvo"),
        tokenProvider: .init { "fresh-jwt" },
        session: session
    )
    let result = try await client.deleteAccount()
    #expect(result.value.deleted)
    #expect(!result.value.idempotent)
    #expect(result.value.userID == "internal-user")
    #expect(result.metadata.requestID == "req_account_delete")
}

@Test("the Swift registry exactly covers the frozen enumerable errors")
func errorRegistry() {
    #expect(Set(WeirgateErrorType.allCases.map(\.rawValue)) == Set([
        "invalid_request", "invalid_token", "user_provider_key_required",
        "user_provider_key_invalid", "insufficient_scope", "out_of_allowance",
        "abuse_blocked", "feature_disabled", "feature_not_found", "resource_not_found",
        "resource_conflict",
        "provider_policy_blocked", "output_contract_unsupported", "output_contract_violation",
        "proposal_stale", "rate_limited", "telemetry_request_unavailable",
        "provider_unavailable", "internal"
    ]))
}

@Test("stream contract requires final usage, finish reason, and DONE")
func streamContract() throws {
    let decoder = JSONDecoder()
    var complete = SSEContractAccumulator()
    _ = try complete.consume(
        line: #"data: {"id":"c","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}"#,
        decoder: decoder
    )
    let final = try complete.consume(
        line: #"data: {"id":"c","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
        decoder: decoder
    )
    _ = try complete.consume(line: "data: [DONE]", decoder: decoder)
    try complete.validate()
    #expect(final?.usage?.totalTokens == 2)

    var interrupted = SSEContractAccumulator()
    _ = try interrupted.consume(
        line: #"data: {"id":"c","object":"chat.completion.chunk","choices":[{"delta":{"content":"partial"}}]}"#,
        decoder: decoder
    )
    #expect(throws: SSEContractAccumulator.ParsingError.self) { try interrupted.validate() }
}

@Test("output contract fields decode from the frozen shape")
func outputContractDecode() throws {
    let data = Data(#"""
    {
      "max_visible_output_tokens": 800,
      "min_visible_output_tokens": 1,
      "reasoning": {"mode": "bounded", "max_tokens": 256},
      "accepted_finish_reasons": ["stop", "length"],
      "on_unsupported_reasoning": "use_compatible_route"
    }
    """#.utf8)
    let contract = try JSONDecoder().decode(OutputContract.self, from: data)
    #expect(contract.maxVisibleOutputTokens == 800)
    #expect(contract.reasoning?.maxTokens == 256)
    #expect(contract.onUnsupportedReasoning == .useCompatibleRoute)
}

@Test("user provider keys cannot leak through descriptions")
func providerKeyRedaction() throws {
    let key = try UserProviderKey("secret-value")
    #expect(key.description == "<redacted>")
    #expect(key.debugDescription == "UserProviderKey(<redacted>)")
    #expect(!String(describing: key).contains("secret-value"))
}

@Test("package records frozen spec provenance")
func provenance() {
    #expect(WeirgateKitInfo.version == "0.2.0")
    #expect(WeirgateKitInfo.apiVersion == "2026-07-18")
    #expect(WeirgateKitInfo.specSourceCommit == "00f542e0276921446e7867170623c67e0f30a7d9")
}

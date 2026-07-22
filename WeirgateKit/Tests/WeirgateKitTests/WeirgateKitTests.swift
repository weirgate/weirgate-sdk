import Foundation
import Testing
@testable import WeirgateKit

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

@Test("the Swift registry exactly covers the frozen enumerable errors")
func errorRegistry() {
    #expect(Set(WeirgateErrorType.allCases.map(\.rawValue)) == Set([
        "invalid_request", "invalid_token", "user_provider_key_required",
        "user_provider_key_invalid", "insufficient_scope", "out_of_allowance",
        "abuse_blocked", "feature_disabled", "feature_not_found", "resource_not_found",
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
    #expect(WeirgateKitInfo.apiVersion == "2026-07-18")
    #expect(WeirgateKitInfo.specSourceCommit == "69a4e6b2f081ff9c7afd8cdc12618f9e2bd84a82")
}

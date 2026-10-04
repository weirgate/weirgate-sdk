import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import WeirgateKit

// Funding rails v2, Phase 2. Every server response here was recorded from weirgate main
// 0738d89 running in-process (fixtures/funding-rails/record.mts). OpenAI offers no
// plan-usage sandbox before partner approval, so nothing here reaches a real plan.

// MARK: - Recorded fixtures

private struct Recorded: Decodable {
    struct Response: Decodable {
        let status: Int
        let headers: [String: String]
        let body: String
    }
    let response: Response
}

private let recordings: [String: Recorded] = {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("fixtures/funding-rails/weirgate-0738d89.json")
    let data = try! Data(contentsOf: url)
    var object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    object["source"] = nil
    return try! JSONDecoder().decode([String: Recorded].self, from: JSONSerialization.data(withJSONObject: object))
}()

/// A recorded response, optionally with its error `detail.next_rail` set. The server
/// leaves it null before headers (it falls through inside the request), so the tests set
/// it there to exercise the SDK's retry rule; mid-stream recordings carry the real value.
private func replay(_ name: String, _ request: URLRequest, nextRail: String? = nil) -> (HTTPURLResponse, Data) {
    let recorded = recordings[name]!.response
    var body = recorded.body
    if let nextRail { body = body.replacingOccurrences(of: #""next_rail":null"#, with: #""next_rail":"\#(nextRail)""#) }
    return (HTTPURLResponse(url: request.url!, statusCode: recorded.status, httpVersion: nil, headerFields: recorded.headers)!, Data(body.utf8))
}

private actor FakePlanSource: PlanCredentialSource {
    nonisolated let provider: PlanProvider
    private(set) var token: String?
    private var refreshResults: [PlanRefreshResult]
    private(set) var refreshCalls: [String] = []
    private(set) var reconnects: [PlanReconnectReason] = []

    init(provider: PlanProvider = .openAIChatGPT, token: String?, refreshResults: [PlanRefreshResult] = []) {
        self.provider = provider
        self.token = token
        self.refreshResults = refreshResults
    }

    func fundingAccessToken() -> String? { token }

    func refreshAccessToken(rejected: String) -> PlanRefreshResult {
        refreshCalls.append(rejected)
        let result = refreshResults.isEmpty ? .reconnectRequired(.refreshRejected(oauthError: "invalid_grant")) : refreshResults.removeFirst()
        if case .refreshed(let fresh) = result { token = fresh } else { token = nil }
        return result
    }

    func requireReconnect(_ reason: PlanReconnectReason) {
        reconnects.append(reason)
        token = nil
    }
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func append(_ request: URLRequest) { lock.withLock { requests.append(request) } }
    var all: [URLRequest] { lock.withLock { requests } }
    var posts: [URLRequest] { all.filter { $0.httpMethod == "POST" } }
}

/// A client whose catalog GETs replay the recorded catalog and whose POSTs go to `handler`
/// (called with the 0-based POST index).
private func fundingClient(
    plan: (any PlanCredentialSource)?,
    preference: FundingPreference = .serverChain,
    _ handler: @escaping @Sendable (URLRequest, Int) -> (HTTPURLResponse, Data)
) -> (client: WeirgateClient, log: RequestLog, tearDown: @Sendable () -> Void) {
    let host = "\(UUID().uuidString.lowercased()).example.test"
    let log = RequestLog()
    let posts = Counter()
    StubURLProtocol.register(host: host) { request in
        log.append(request)
        if request.httpMethod == "GET", request.url?.path == "/v1/features" { return replay("catalog", request) }
        return handler(request, posts.syncIncrement() - 1)
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let client = WeirgateClient(
        configuration: .init(
            baseURL: URL(string: "https://\(host)")!,
            appID: "example-app",
            // Telemetry would outlive the stub session these tests tear down.
            automaticallySubmitTelemetry: false,
            fundingPreference: preference
        ),
        tokenProvider: .init { "end-user-jwt" },
        session: session,
        planCredential: plan
    )
    return (client, log, {
        StubURLProtocol.remove(host: host)
        session.invalidateAndCancel()
    })
}

private let hello = ChatCompletionRequest(messages: [.text(role: "user", content: "hello")])

private func header(_ request: URLRequest, _ name: String) -> String? { request.value(forHTTPHeaderField: name) }

// MARK: - Catalog helpers

@Test("the recorded catalog decodes funding order and plan providers")
func catalogFunding() throws {
    let catalog = try JSONDecoder().decode(FeatureCatalog.self, from: Data(recordings["catalog"]!.response.body.utf8))
    let assistant = try #require(catalog.data.first { $0.featureID == "assistant" })
    #expect(assistant.funding?.order == [.userPlan, .developer])
    #expect(assistant.funding?.planProviders == [.openAIChatGPT])
    #expect(assistant.acceptsPlan(.openAIChatGPT))
    let summaries = try #require(catalog.data.first { $0.featureID == "summaries" })
    #expect(summaries.funding?.order == [.developer])
    #expect(!summaries.acceptsPlan(.openAIChatGPT))
    #expect(catalog.features(acceptingPlan: .openAIChatGPT).map(\.featureID) == ["assistant", "assistant-stop"])
    #expect(catalog.offersPlan(.openAIChatGPT))
    #expect(!catalog.offersPlan(PlanProvider(rawValue: "anthropic_claude")))
}

@Test("rails and providers are open-ended; a catalog without funding still decodes")
func openEndedFunding() throws {
    let data = Data(#"""
    {"catalog_version":"cat_1_0123456789abcdef","data":[
      {"feature_id":"a","modality":"chat","key_policy":"user","display_label":"A",
       "availability":{"available":true,"reason":null},"provider_policy":{"effective_state":"allowed"},
       "funding":{"order":["user_wallet","user_plan"],"plan_providers":["google_gemini","openai_chatgpt"]}},
      {"feature_id":"b","modality":"chat","key_policy":"developer","display_label":"B",
       "availability":{"available":true,"reason":null},"provider_policy":{"effective_state":"allowed"}}]}
    """#.utf8)
    let catalog = try JSONDecoder().decode(FeatureCatalog.self, from: data)
    #expect(catalog.data[0].funding?.order.first?.rawValue == "user_wallet")
    #expect(catalog.data[0].acceptsPlan(.openAIChatGPT))
    #expect(catalog.data[1].funding == nil)
    #expect(!catalog.data[1].acceptsPlan(.openAIChatGPT))
}

@Test("funding headers parse rail, provider, fallback reason, and disable")
func fundingHeaderParsing() {
    let plan = FundingOutcome(railHeader: "user_plan; provider=openai_chatgpt", fallbackHeader: nil)
    #expect(plan == FundingOutcome(rail: .userPlan, provider: .openAIChatGPT))
    let disabled = FundingOutcome(railHeader: "developer", fallbackHeader: "user_plan; reason=user_not_eligible; disable")
    #expect(disabled?.rail == .developer)
    #expect(disabled?.fallback == .init(refusedRail: .userPlan, reason: "user_not_eligible", disable: true))
    #expect(FundingOutcome(railHeader: "user_wallet", fallbackHeader: nil)?.rail?.rawValue == "user_wallet")
    #expect(FundingOutcome(railHeader: nil, fallbackHeader: nil) == nil)
}

// MARK: - Header injection

@Test("a connected plan's token is sent to a feature that accepts it, and the paying rail is reported")
func injectsPlanCredential() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("plan_success", request) }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello, options: .init(idempotencyKey: "k1"))
    let post = try #require(log.posts.first)
    #expect(header(post, "X-Weirgate-User-Credential") == "plan-access-token")
    // The server picks the feature's first plan provider, which is ours: no funding header.
    #expect(header(post, "X-Weirgate-Funding") == nil)
    #expect(header(post, "X-Idempotency-Key") == "k1")
    #expect(response.metadata.funding == FundingOutcome(rail: .userPlan, provider: .openAIChatGPT))
    // The catalog was read once to learn the feature's chain.
    #expect(log.all.filter { $0.httpMethod == "GET" }.count == 1)
}

@Test("the token is not sent to a feature whose chain has no plan rail")
func skipsFeatureWithoutPlan() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("start_at_developer", request) }
    defer { tearDown() }
    _ = try await client.chat(featureID: "summaries", request: hello)
    _ = try await client.chat(featureID: "summaries", request: hello)
    #expect(log.posts.allSatisfy { header($0, "X-Weirgate-User-Credential") == nil && header($0, "X-Weirgate-Funding") == nil })
    #expect(log.all.filter { $0.httpMethod == "GET" }.count == 1)
}

@Test("without a plan connection requests are unchanged and the catalog is not read")
func noPlanNoChange() async throws {
    let (client, log, tearDown) = fundingClient(plan: nil) { request, _ in replay("start_at_developer", request) }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello)
    #expect(log.all.count == 1)
    #expect(header(log.posts[0], "X-Weirgate-User-Credential") == nil)
    #expect(header(log.posts[0], "X-Weirgate-Funding") == nil)
    #expect(header(log.posts[0], "X-Idempotency-Key") != nil)
    #expect(response.metadata.funding?.rail == .developer)
}

@Test("a plan that is not funding (no token) sends nothing and reads no catalog")
func notFundingPlan() async throws {
    let plan = FakePlanSource(token: nil)
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("start_at_developer", request) }
    defer { tearDown() }
    _ = try await client.chat(featureID: "assistant", request: hello)
    #expect(log.all.count == 1)
    #expect(header(log.posts[0], "X-Weirgate-User-Credential") == nil)
}

@Test("a preference that starts past the plan rail sends the funding header and no token")
func startAtDeveloper() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan, preference: .startAt(.developer)) { request, _ in
        replay("start_at_developer", request)
    }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello)
    #expect(header(log.posts[0], "X-Weirgate-Funding") == "developer")
    #expect(header(log.posts[0], "X-Weirgate-User-Credential") == nil)
    #expect(response.metadata.funding?.rail == .developer)

    // A per-call override wins over the client default.
    _ = try await client.chat(featureID: "assistant", request: hello, options: .init(funding: .startAt(.userPlan)))
    #expect(header(log.posts[1], "X-Weirgate-Funding") == "user_plan; provider=openai_chatgpt")
    #expect(header(log.posts[1], "X-Weirgate-User-Credential") == "plan-access-token")
}

// MARK: - Fallback headers

@Test("an in-request fallback is reported and leaves the plan connected")
func fallbackWithoutDisable() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, _, tearDown) = fundingClient(plan: plan) { request, _ in replay("fallback_plan_limit", request) }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello)
    #expect(response.metadata.funding?.rail == .developer)
    #expect(response.metadata.funding?.fallback == .init(refusedRail: .userPlan, reason: "plan_limit_exceeded", disable: false))
    #expect(await plan.reconnects.isEmpty)
    #expect(await plan.token == "plan-access-token")
}

@Test("a disable fallback clears the plan and asks the user to reconnect")
func fallbackDisable() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, _, tearDown) = fundingClient(plan: plan) { request, _ in replay("fallback_disable", request) }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello)
    #expect(response.metadata.funding?.fallback?.disable == true)
    #expect(await plan.reconnects == [.railDisabled(reason: "user_not_eligible")])
}

// MARK: - Retry rules

@Test("user_credential_expired refreshes once and retries with the same idempotency key")
func credentialExpiredRefreshes() async throws {
    let plan = FakePlanSource(token: "stale-access-token", refreshResults: [.refreshed("fresh-access-token")])
    let (client, log, tearDown) = fundingClient(plan: plan) { request, index in
        index == 0 ? replay("credential_expired", request) : replay("credential_expired_retry_same_key", request)
    }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello, options: .init(idempotencyKey: "k-expired"))
    #expect(response.metadata.funding?.rail == .userPlan)
    #expect(await plan.refreshCalls == ["stale-access-token"])
    #expect(log.posts.map { header($0, "X-Weirgate-User-Credential") } == ["stale-access-token", "fresh-access-token"])
    #expect(log.posts.map { header($0, "X-Idempotency-Key") } == ["k-expired", "k-expired"])
}

@Test("a second user_credential_expired after refresh clears the plan and surfaces reconnect")
func credentialRejectedAfterRefresh() async throws {
    let plan = FakePlanSource(token: "stale-access-token", refreshResults: [.refreshed("fresh-access-token")])
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("credential_expired", request) }
    defer { tearDown() }
    do {
        _ = try await client.chat(featureID: "assistant", request: hello)
        Issue.record("expected reconnect")
    } catch let error as FundingRailError {
        #expect(error.code == .reconnectRequired(.credentialRejected(providerCode: "subscription_sharing_invalid_user")))
        #expect(error.isReconnectRequired)
        #expect(error.providerRequestID == "oai-req-123")
    }
    #expect(log.posts.count == 2)
    #expect(await plan.reconnects == [.credentialRejected(providerCode: "subscription_sharing_invalid_user")])
}

@Test("a refused refresh (invalid_grant) surfaces reconnect; the next call goes out without the plan")
func refreshRejected() async throws {
    let plan = FakePlanSource(token: "stale-access-token", refreshResults: [.reconnectRequired(.refreshRejected(oauthError: "invalid_grant"))])
    let (client, log, tearDown) = fundingClient(plan: plan) { request, index in
        index == 0 ? replay("credential_expired", request) : replay("start_at_developer", request)
    }
    defer { tearDown() }
    do {
        _ = try await client.chat(featureID: "assistant", request: hello)
        Issue.record("expected reconnect")
    } catch let error as FundingRailError {
        #expect(error.code == .reconnectRequired(.refreshRejected(oauthError: "invalid_grant")))
    }
    #expect(log.posts.count == 1)
    let retried = try await client.chat(featureID: "assistant", request: hello)
    #expect(header(log.posts[1], "X-Weirgate-User-Credential") == nil)
    #expect(retried.metadata.funding?.rail == .developer)
}

@Test("user_credential_expired without a plan source is a typed error")
func credentialExpiredWithoutSource() async throws {
    let (client, _, tearDown) = fundingClient(plan: nil) { request, _ in replay("credential_expired", request) }
    defer { tearDown() }
    do {
        _ = try await client.chat(featureID: "assistant", request: hello)
        Issue.record("expected an error")
    } catch let error as FundingRailError {
        #expect(error.code == .credentialExpired)
        #expect(error.rail == .userPlan)
        #expect(error.providerCode == "subscription_sharing_invalid_user")
    }
}

@Test("funding_rail_refused with next_rail retries once on that rail with the rail's idempotency key")
func refusedRetriesNextRail() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, index in
        index == 0 ? replay("rail_refused_stop", request, nextRail: "developer") : replay("start_at_developer", request)
    }
    defer { tearDown() }
    let response = try await client.chat(featureID: "assistant", request: hello, options: .init(idempotencyKey: "k-stop"))
    #expect(response.metadata.funding?.rail == .developer)
    #expect(log.posts.count == 2)
    #expect(header(log.posts[1], "X-Weirgate-Funding") == "developer")
    #expect(header(log.posts[1], "X-Weirgate-User-Credential") == nil)
    #expect(header(log.posts[1], "X-Idempotency-Key") == "k-stop:rail:developer")
}

@Test("funding_rail_refused without next_rail is thrown with the provider request ID")
func refusedWithoutNextRail() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("rail_refused_stop", request) }
    defer { tearDown() }
    do {
        _ = try await client.chat(featureID: "assistant-stop", request: hello)
        Issue.record("expected an error")
    } catch let error as FundingRailError {
        #expect(error.code == .railRefused)
        #expect(error.reason == "plan_limit_exceeded")
        #expect(error.nextRail == nil)
        #expect(error.retryOptions() == nil)
        #expect(error.providerRequestID == "oai-req-123")
        #expect(error.underlying?.statusCode == 402)
    }
    #expect(log.posts.count == 1)
    #expect(await plan.reconnects.isEmpty)
}

@Test("next_rail hops are bounded")
func boundedHops() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("rail_refused_stop", request, nextRail: "developer") }
    defer { tearDown() }
    await #expect(throws: FundingRailError.self) { _ = try await client.chat(featureID: "assistant", request: hello) }
    #expect(log.posts.count == 3)
}

@Test("funding_rail_unavailable is typed and not retried")
func railUnavailable() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("rail_unavailable_not_approved", request) }
    defer { tearDown() }
    do {
        _ = try await client.chat(featureID: "assistant", request: hello)
        Issue.record("expected an error")
    } catch let error as FundingRailError {
        #expect(error.code == .railUnavailable)
        #expect(error.reason == "provider_not_approved")
        #expect(error.underlying?.statusCode == 403)
    }
    #expect(log.posts.count == 1)
    #expect(await plan.reconnects.isEmpty)
}

// MARK: - Streaming

@Test("a plan-funded stream completes and reports the rail")
func streamPlanSuccess() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, _ in replay("stream_plan_success", request) }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello)
    var text = ""
    for try await chunk in stream.chunks { text += chunk.choices.compactMap { $0.delta?.content }.joined() }
    #expect(text == "plan-1 plan-2 plan-3")
    #expect(stream.metadata.funding == FundingOutcome(rail: .userPlan, provider: .openAIChatGPT))
    #expect(header(log.posts[0], "X-Weirgate-User-Credential") == "plan-access-token")
}

@Test("the mid-stream error frame throws a typed FundingRailError after the partial chunks")
func streamMidStreamRefusal() async throws {
    for (recording, nextRail) in [("stream_mid_stream_limit_stop", nil), ("stream_mid_stream_limit", "developer")] as [(String, String?)] {
        let plan = FakePlanSource(token: "plan-access-token")
        let (client, _, tearDown) = fundingClient(plan: plan) { request, _ in replay(recording, request) }
        defer { tearDown() }
        let stream = try await client.streamChat(featureID: "assistant", request: hello, options: .init(idempotencyKey: "k-s2"))
        var partial = 0
        do {
            for try await _ in stream.chunks { partial += 1 }
            Issue.record("expected the stream to fail")
        } catch let error as FundingRailError {
            #expect(error.code == .railRefused)
            #expect(error.reason == "plan_limit_exceeded")
            #expect(error.providerCode == "subscription_sharing_usage_limit_exceeded")
            #expect(error.requestID == stream.metadata.requestID)
            if nextRail == nil {
                #expect(error.retryOptions() == nil)
            } else {
                let retry = try #require(error.retryOptions())
                #expect(retry.funding == .startAt(.developer))
                #expect(retry.idempotencyKey == "k-s2:rail:developer")
            }
        }
        #expect(partial > 0)
    }
}

@Test("a mid-stream disable flag disconnects the plan the stream was using")
func streamMidStreamDisable() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, _, tearDown) = fundingClient(plan: plan) { request, _ in replay("stream_mid_stream_not_eligible", request) }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello, options: .init(idempotencyKey: "k-s4"))
    do {
        for try await _ in stream.chunks {}
        Issue.record("expected the stream to fail")
    } catch let error as FundingRailError {
        #expect(error.code == .railRefused)
        #expect(error.reason == "user_not_eligible")
        #expect(error.disablesRail)
        #expect(error.retryOptions()?.funding == .startAt(.developer))
    }
    #expect(await plan.reconnects == [.railDisabled(reason: "user_not_eligible")])
    #expect(await plan.token == nil)
}

@Test("a mid-stream refusal without disable leaves the plan connected")
func streamMidStreamNoDisable() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, _, tearDown) = fundingClient(plan: plan) { request, _ in replay("stream_mid_stream_limit", request) }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello)
    do {
        for try await _ in stream.chunks {}
    } catch let error as FundingRailError {
        #expect(!error.disablesRail)
    }
    #expect(await plan.reconnects.isEmpty)
    #expect(await plan.token == "plan-access-token")
}

@Test("a mid-stream disable flag on a stream that sent no plan token disconnects nothing")
func streamMidStreamDisableWithoutToken() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan, preference: .startAt(.developer)) { request, _ in
        replay("stream_mid_stream_not_eligible", request)
    }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello)
    do {
        for try await _ in stream.chunks {}
    } catch let error as FundingRailError {
        #expect(error.disablesRail)
    }
    #expect(header(log.posts[0], "X-Weirgate-User-Credential") == nil)
    #expect(await plan.reconnects.isEmpty)
}

@Test("a stream rejected before headers refreshes the plan and retries")
func streamCredentialExpired() async throws {
    let plan = FakePlanSource(token: "stale-access-token", refreshResults: [.refreshed("fresh-access-token")])
    let (client, log, tearDown) = fundingClient(plan: plan) { request, index in
        index == 0 ? replay("credential_expired", request) : replay("stream_plan_success", request)
    }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello)
    for try await _ in stream.chunks {}
    #expect(log.posts.map { header($0, "X-Weirgate-User-Credential") } == ["stale-access-token", "fresh-access-token"])
    #expect(header(log.posts[0], "X-Idempotency-Key") == header(log.posts[1], "X-Idempotency-Key"))
}

@Test("a stream refused before headers with next_rail retries on that rail")
func streamRefusedRetriesNextRail() async throws {
    let plan = FakePlanSource(token: "plan-access-token")
    let (client, log, tearDown) = fundingClient(plan: plan) { request, index in
        index == 0 ? replay("rail_refused_stop", request, nextRail: "developer") : replay("stream_plan_success", request)
    }
    defer { tearDown() }
    let stream = try await client.streamChat(featureID: "assistant", request: hello)
    for try await _ in stream.chunks {}
    #expect(header(log.posts[1], "X-Weirgate-Funding") == "developer")
}

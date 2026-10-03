#if canImport(CryptoKit) && canImport(Security)
import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import WeirgateKit

// PlanConnect against a stubbed token endpoint shaped like OpenAI's documented Sign in with
// ChatGPT responses (token reference, read 2026-10-03). No real sign-in happens here.

private final class Box<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private func requestBody(_ request: URLRequest) -> Data {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
    }
    return data
}

private func form(_ request: URLRequest) -> [String: String] {
    let body = String(decoding: requestBody(request), as: UTF8.self)
    var result: [String: String] = [:]
    for pair in body.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
        result[parts[0]] = parts.count > 1 ? parts[1] : ""
    }
    return result
}

private func query(_ url: URL) -> [String: String] {
    Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }) { $1 }
}

private func jwt(_ claims: [String: Any]) -> String {
    let payload = try! JSONSerialization.data(withJSONObject: claims)
    return "eyJhbGciOiJSUzI1NiJ9.\(PlanConnect.base64URL(payload)).signature"
}

private struct FakeAuthorizer: PlanAuthorizer {
    let seen: Box<[URL]>
    /// Builds the redirect from the authorization URL (state echoes by default).
    let redirect: @Sendable (URL) -> URL

    func authorize(url: URL, redirectURI: URL) async throws -> URL {
        seen.value.append(url)
        return redirect(url)
    }
}

private struct Harness {
    let plan: PlanConnect
    let store: InMemoryPlanTokenStore
    let authorizations: Box<[URL]>
    let tokenRequests: Box<[[String: String]]>
    let revocations: Box<[[String: String]]>
    let clock: Box<Date>
    let tearDown: @Sendable () -> Void
}

/// - Parameter tokenResponse: answers each token-endpoint form (status, JSON body); the
///   authorization nonce is passed in for building ID tokens.
private func harness(
    store: InMemoryPlanTokenStore = InMemoryPlanTokenStore(),
    redirect: (@Sendable (URL) -> URL)? = nil,
    tokenResponse: @escaping @Sendable (_ form: [String: String], _ nonce: String) -> (Int, [String: Any])
) -> Harness {
    let host = "\(UUID().uuidString.lowercased()).auth.example.test"
    let authorizations = Box<[URL]>([])
    let tokenRequests = Box<[[String: String]]>([])
    let revocations = Box<[[String: String]]>([])
    let clock = Box(Date(timeIntervalSince1970: 1_790_000_000))
    StubURLProtocol.register(host: host) { request in
        let ok = { (status: Int, json: [String: Any]) in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!,
             try! JSONSerialization.data(withJSONObject: json))
        }
        switch request.url?.path {
        case "/.well-known/openid-configuration":
            return ok(200, ["revocation_endpoint": "https://\(host)/oauth/revoke"])
        case "/oauth/revoke":
            revocations.value.append(form(request))
            return ok(200, [:])
        default:
            let fields = form(request)
            tokenRequests.value.append(fields)
            let nonce = authorizations.value.last.map { query($0)["nonce"] ?? "" } ?? ""
            let (status, json) = tokenResponse(fields, nonce)
            return ok(status, json)
        }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    var config = PlanConnect.Configuration.openAIChatGPT(
        clientID: "app-client-id",
        redirectURI: URL(string: "exampleapp://oauth/chatgpt")!,
        agentNameHint: "Example App"
    )
    config.issuer = "https://auth.openai.com"
    config.tokenEndpoint = URL(string: "https://\(host)/oauth/token")!
    config.discoveryURL = URL(string: "https://\(host)/.well-known/openid-configuration")!
    let authorizer = FakeAuthorizer(seen: authorizations, redirect: redirect ?? { url in
        URL(string: "exampleapp://oauth/chatgpt?code=auth-code&state=\(query(url)["state"]!)")!
    })
    let plan = PlanConnect(configuration: config, authorizer: authorizer, store: store, session: session, now: { clock.value })
    return Harness(
        plan: plan, store: store, authorizations: authorizations, tokenRequests: tokenRequests,
        revocations: revocations, clock: clock,
        tearDown: { StubURLProtocol.remove(host: host); session.invalidateAndCancel() }
    )
}

private let allScopes = "openid profile email offline_access chatgpt.tokens.use.direct"

private func signIn(scope: String = allScopes, access: String = "access-1", refresh: String = "refresh-1", nonceOverride: String? = nil)
    -> @Sendable ([String: String], String) -> (Int, [String: Any]) {
    { fields, nonce in
        if fields["grant_type"] == "authorization_code" {
            return (200, [
                "access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600, "scope": scope,
                "id_token": jwt(["iss": "https://auth.openai.com", "aud": "app-client-id", "sub": "user-sub",
                                 "email": "person@example.com", "name": "Person", "nonce": nonceOverride ?? nonce,
                                 "exp": 1_790_003_600]),
            ])
        }
        let n = Int(fields["refresh_token"]!.split(separator: "-").last!)! + 1
        return (200, ["access_token": "access-\(n)", "refresh_token": "refresh-\(n)", "token_type": "Bearer", "expires_in": 3600, "scope": scope])
    }
}

@Test("connect sends the documented OIDC + PKCE request and stores the funding tokens")
func connectFlow() async throws {
    let h = harness(tokenResponse: signIn())
    defer { h.tearDown() }
    let status = try await h.plan.connect()
    #expect(status == .connected(identity: PlanIdentity(subject: "user-sub", email: "person@example.com", name: "Person"), funding: true))

    let authorize = query(try #require(h.authorizations.value.first))
    #expect(authorize["client_id"] == "app-client-id")
    #expect(authorize["response_type"] == "code")
    #expect(authorize["redirect_uri"] == "exampleapp://oauth/chatgpt")
    #expect(authorize["scope"] == allScopes)
    #expect(authorize["resource"] == "https://api.openai.com/v1")
    #expect(authorize["code_challenge_method"] == "S256")
    #expect(authorize["agent_name_hint"] == "Example App")
    #expect(authorize["prompt"] == nil)
    #expect(authorize["ext_agent_host_id"]?.hasPrefix("urn:uuid:") == true)
    #expect((authorize["state"]?.count ?? 0) >= 16 && (authorize["nonce"]?.count ?? 0) >= 16)

    let exchange = try #require(h.tokenRequests.value.first)
    #expect(exchange["grant_type"] == "authorization_code")
    #expect(exchange["code"] == "auth-code")
    #expect(exchange["client_id"] == "app-client-id")
    #expect(exchange["redirect_uri"] == "exampleapp://oauth/chatgpt")
    #expect(exchange["resource"] == "https://api.openai.com/v1")
    let verifier = try #require(exchange["code_verifier"])
    #expect(PlanConnect.base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) == authorize["code_challenge"])

    #expect(try await h.plan.fundingAccessToken() == "access-1")
    #expect(try await h.store.load(account: "openai_chatgpt.tokens") != nil)
}

@Test("the host ID is stable across sign-ins and plan instances sharing a store")
func stableHostID() async throws {
    let store = InMemoryPlanTokenStore()
    let first = harness(store: store, tokenResponse: signIn())
    defer { first.tearDown() }
    try await first.plan.connect()
    try await first.plan.disconnect()
    try await first.plan.connect()
    let second = harness(store: store, tokenResponse: signIn())
    defer { second.tearDown() }
    try await second.plan.connect()
    let ids = (first.authorizations.value + second.authorizations.value).map { query($0)["ext_agent_host_id"] }
    #expect(Set(ids).count == 1)
    #expect(try await second.plan.hostID() == ids[0])
}

@Test("without chatgpt.tokens.use.direct the sign-in is kept for identity but does not fund")
func identityOnly() async throws {
    let h = harness(tokenResponse: signIn(scope: "openid profile email offline_access"))
    defer { h.tearDown() }
    let status = try await h.plan.connect()
    guard case .connected(let identity, let funding) = status else { Issue.record("expected connected"); return }
    #expect(identity?.subject == "user-sub")
    #expect(!funding)
    #expect(try await h.plan.fundingAccessToken() == nil)
}

@Test("enablePlanUsage repeats sign-in with prompt=consent")
func reconsent() async throws {
    let granted = Box(false)
    let h = harness { fields, nonce in
        let scope = granted.value ? allScopes : "openid profile email offline_access"
        return signIn(scope: scope)(fields, nonce)
    }
    defer { h.tearDown() }
    try await h.plan.connect()
    granted.value = true
    let status = try await h.plan.enablePlanUsage()
    guard case .connected(_, let funding) = status else { Issue.record("expected connected"); return }
    #expect(funding)
    let second = query(h.authorizations.value[1])
    #expect(second["prompt"] == "consent")
    #expect(second["login_hint"] == "person@example.com")
}

@Test("a mismatched state, an error redirect, or a wrong nonce fails the sign-in")
func signInValidation() async throws {
    let badState = harness(redirect: { _ in URL(string: "exampleapp://oauth/chatgpt?code=c&state=forged")! }, tokenResponse: signIn())
    defer { badState.tearDown() }
    await #expect(throws: PlanConnectError.stateMismatch) { try await badState.plan.connect() }

    let denied = harness(redirect: { url in URL(string: "exampleapp://oauth/chatgpt?error=access_denied&state=\(query(url)["state"]!)")! }, tokenResponse: signIn())
    defer { denied.tearDown() }
    await #expect(throws: PlanConnectError.authorizationDenied("access_denied")) { try await denied.plan.connect() }
    #expect(denied.tokenRequests.value.isEmpty)

    let badNonce = harness(tokenResponse: signIn(nonceOverride: "replayed"))
    defer { badNonce.tearDown() }
    await #expect(throws: PlanConnectError.invalidIDToken("nonce")) { try await badNonce.plan.connect() }
    #expect(try await badNonce.plan.status() == .disconnected)
}

@Test("the access token is refreshed only inside the last five minutes, and the rotated refresh token is stored")
func proactiveRefresh() async throws {
    let h = harness(tokenResponse: signIn())
    defer { h.tearDown() }
    try await h.plan.connect()
    h.clock.value += 54 * 60
    #expect(try await h.plan.fundingAccessToken() == "access-1")
    #expect(h.tokenRequests.value.count == 1)

    h.clock.value += 2 * 60
    #expect(try await h.plan.fundingAccessToken() == "access-2")
    let refresh = h.tokenRequests.value[1]
    #expect(refresh["grant_type"] == "refresh_token")
    #expect(refresh["refresh_token"] == "refresh-1")
    #expect(refresh["client_id"] == "app-client-id")
    #expect(refresh["resource"] == "https://api.openai.com/v1")

    h.clock.value += 56 * 60
    #expect(try await h.plan.fundingAccessToken() == "access-3")
    #expect(h.tokenRequests.value[2]["refresh_token"] == "refresh-2")
}

@Test("concurrent refreshes after a rejection share one token request")
func serializedRefresh() async throws {
    let h = harness(tokenResponse: signIn())
    defer { h.tearDown() }
    try await h.plan.connect()
    async let a = h.plan.refreshAccessToken(rejected: "access-1")
    async let b = h.plan.refreshAccessToken(rejected: "access-1")
    let results = try await [a, b]
    #expect(results == [.refreshed("access-2"), .refreshed("access-2")])
    #expect(h.tokenRequests.value.count == 2)
    // A rejection of a token already replaced returns the current one without a request.
    #expect(try await h.plan.refreshAccessToken(rejected: "access-1") == .refreshed("access-2"))
    #expect(h.tokenRequests.value.count == 2)
}

@Test("invalid_grant on refresh clears the tokens and reports reconnect")
func refreshInvalidGrant() async throws {
    let h = harness { fields, nonce in
        fields["grant_type"] == "refresh_token" ? (400, ["error": "invalid_grant"]) : signIn()(fields, nonce)
    }
    defer { h.tearDown() }
    try await h.plan.connect()
    let updates = await h.plan.statusUpdates()
    var iterator = updates.makeAsyncIterator()
    #expect(await iterator.next().map { if case .connected = $0 { true } else { false } } == true)

    #expect(try await h.plan.refreshAccessToken(rejected: "access-1") == .reconnectRequired(.refreshRejected(oauthError: "invalid_grant")))
    #expect(await iterator.next() == .reconnectRequired(.refreshRejected(oauthError: "invalid_grant")))
    #expect(try await h.plan.fundingAccessToken() == nil)

    // The reason survives a relaunch.
    let relaunched = harness(store: h.store, tokenResponse: signIn())
    defer { relaunched.tearDown() }
    #expect(try await relaunched.plan.status() == .reconnectRequired(.refreshRejected(oauthError: "invalid_grant")))
}

@Test("a transient refresh failure keeps the still-valid token")
func transientRefreshFailure() async throws {
    let h = harness { fields, nonce in
        fields["grant_type"] == "refresh_token" ? (503, ["error": "temporarily_unavailable"]) : signIn()(fields, nonce)
    }
    defer { h.tearDown() }
    try await h.plan.connect()
    h.clock.value += 57 * 60
    #expect(try await h.plan.fundingAccessToken() == "access-1")
    await #expect(throws: PlanConnectError.tokenEndpoint(status: 503, error: "temporarily_unavailable")) {
        _ = try await h.plan.refreshAccessToken(rejected: "access-1")
    }
    guard case .connected = try await h.plan.status() else { Issue.record("expected still connected"); return }
}

@Test("disconnect revokes the refresh token at the discovered endpoint and keeps the host ID")
func disconnectRevokes() async throws {
    let h = harness(tokenResponse: signIn())
    defer { h.tearDown() }
    try await h.plan.connect()
    let hostID = try await h.plan.hostID()
    try await h.plan.disconnect()
    #expect(h.revocations.value.first?["token"] == "refresh-1")
    #expect(h.revocations.value.first?["token_type_hint"] == "refresh_token")
    #expect(try await h.plan.status() == .disconnected)
    #expect(try await h.store.load(account: "openai_chatgpt.tokens") == nil)
    #expect(try await h.plan.hostID() == hostID)
}

@Test("PlanConnect drives WeirgateClient's refresh-once rule end to end")
func planConnectWithClient() async throws {
    let h = harness(tokenResponse: signIn())
    defer { h.tearDown() }
    try await h.plan.connect()
    let apiHost = "\(UUID().uuidString.lowercased()).api.example.test"
    let credentials = Box<[String?]>([])
    StubURLProtocol.register(host: apiHost) { request in
        let headers = ["Content-Type": "application/json", "Weirgate-Api-Version": "2026-07-18", "X-Weirgate-Request-Id": "req_1"]
        if request.httpMethod == "GET" {
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!, Data(#"""
            {"catalog_version":"cat_1_0123456789abcdef","data":[{"feature_id":"assistant","modality":"chat","key_policy":"user_or_developer",
             "funding":{"order":["user_plan","user_key","developer"],"plan_providers":["openai_chatgpt"]},"display_label":"Assistant",
             "availability":{"available":true,"reason":null},"provider_policy":{"effective_state":"allowed"}}]}
            """#.utf8))
        }
        let credential = request.value(forHTTPHeaderField: "X-Weirgate-User-Credential")
        credentials.value.append(credential)
        if credential == "access-1" {
            return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: headers.merging(["X-Weirgate-Error-Type": "user_credential_expired"]) { $1 })!,
                    Data(#"{"error":{"type":"user_credential_expired","message":"m","request_id":"req_1","detail":{"rail":"user_plan","reason":"credential_expired","next_rail":null}}}"#.utf8))
        }
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers.merging(["X-Weirgate-Funding-Rail": "user_plan; provider=openai_chatgpt"]) { $1 })!,
                Data(#"{"id":"c","object":"chat.completion","choices":[]}"#.utf8))
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { StubURLProtocol.remove(host: apiHost); session.invalidateAndCancel() }
    let client = WeirgateClient(
        configuration: .init(baseURL: URL(string: "https://\(apiHost)")!, appID: "example-app"),
        tokenProvider: .init { "end-user-jwt" },
        session: session,
        planCredential: h.plan
    )
    let response = try await client.chat(featureID: "assistant", request: .init(messages: [.text(role: "user", content: "hi")]))
    #expect(response.metadata.funding?.rail == .userPlan)
    #expect(credentials.value == ["access-1", "access-2"])
    #expect(try await h.plan.fundingAccessToken() == "access-2")
}
#endif

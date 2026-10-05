import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import WeirgateKit

/// Serves canned responses per URL host, so tests that each use their own host can run in
/// parallel.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    static func register(host: String, _ handler: @escaping Handler) {
        lock.withLock { handlers[host] = handler }
    }

    static func remove(host: String) {
        _ = lock.withLock { handlers.removeValue(forKey: host) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        guard let handler = Self.lock.withLock({ Self.handlers[host] }) else {
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

/// A client whose requests go to `handler`, registered under a host unique to the test.
private func stubbedClient(
    _ handler: @escaping StubURLProtocol.Handler
) -> (client: WeirgateClient, tearDown: @Sendable () -> Void) {
    let host = "\(UUID().uuidString.lowercased()).example.test"
    StubURLProtocol.register(host: host, handler)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let client = WeirgateClient(
        configuration: .init(baseURL: URL(string: "https://\(host)")!, appID: "example-app"),
        tokenProvider: .init { "fresh-jwt" },
        session: session
    )
    return (client, {
        StubURLProtocol.remove(host: host)
        session.invalidateAndCancel()
    })
}

private func jsonResponse(
    _ request: URLRequest,
    status: Int = 200,
    headers: [String: String] = [:],
    body: String
) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: nil,
        headerFields: [
            "Content-Type": "application/json",
            "Weirgate-Api-Version": "2026-07-18",
            "X-Weirgate-Request-Id": "req_test",
        ].merging(headers) { $1 }
    )!
    return (response, Data(body.utf8))
}

private func errorResponse(
    _ request: URLRequest,
    status: Int,
    type: String,
    reason: String? = nil,
    headers: [String: String] = [:]
) -> (HTTPURLResponse, Data) {
    let detail = reason.map { #","detail":{"reason":"\#($0)"}"# } ?? ""
    return jsonResponse(
        request,
        status: status,
        headers: ["X-Weirgate-Error-Type": type].merging(headers) { $1 },
        body: #"{"error":{"type":"\#(type)","message":"m","request_id":"req_test"\#(detail)}}"#
    )
}

/// Request bodies arrive as a stream through URLProtocol.
func bodyJSON(_ request: URLRequest) -> [String: String] {
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
    return (try? JSONSerialization.jsonObject(with: data) as? [String: String]) ?? [:]
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func syncIncrement() -> Int { lock.withLock { value += 1; return value } }
    func increment() { _ = syncIncrement() }
}

private actor Delays {
    private(set) var values: [Duration] = []
    func record(_ value: Duration) { values.append(value) }
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
          "display_label": "Example AI",
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
    let (client, tearDown) = stubbedClient { request in
        #expect(request.url?.path == "/v1/account")
        #expect(request.httpMethod == "DELETE")
        #expect(request.httpBody == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-jwt")
        #expect(request.value(forHTTPHeaderField: "X-App-Id") == "example-app")
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
    defer { tearDown() }

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
        "insufficient_balance", "abuse_blocked", "feature_disabled", "feature_not_found", "resource_not_found",
        "resource_conflict",
        "provider_policy_blocked", "output_contract_unsupported", "output_contract_violation",
        "proposal_stale", "rate_limited", "telemetry_request_unavailable",
        "provider_unavailable", "purchase_invalid_signature", "purchase_wrong_app",
        "purchase_environment_mismatch", "purchase_unknown_product", "purchase_revoked",
        "purchase_account_mismatch", "funding_rail_refused", "funding_rail_unavailable",
        "user_credential_expired", "internal"
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
    #expect(WeirgateKitInfo.version == "0.4.1")
    #expect(WeirgateKitInfo.apiVersion == "2026-07-18")
    #expect(WeirgateKitInfo.specSourceCommit == "91580ca0c2c6ca49df1a43628f474c892c8d6c97")
}

// MARK: - Balance

@Test("balance decodes unlimited state and the app account token")
func balanceDecode() throws {
    let unlimited = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":12.5,"units_pending":1,"tier":"early_adopter","unlimited":true,
     "unlimited_until":"2026-12-25T00:00:00.000Z","app_account_token":"6F9619FF-8B86-D011-B42D-00C04FC964FF"}
    """#.utf8))
    #expect(unlimited.unlimited)
    #expect(unlimited.unlimitedUntil == Date(timeIntervalSince1970: 1_798_156_800))
    #expect(unlimited.appAccountToken == UUID(uuidString: "6f9619ff-8b86-d011-b42d-00c04fc964ff"))
    #expect(unlimited.unitsAvailable == 12.5)

    let metered = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":0,"units_pending":0,"tier":"free","unlimited":false,"unlimited_until":null,
     "app_account_token":"6f9619ff-8b86-d011-b42d-00c04fc964ff"}
    """#.utf8))
    #expect(!metered.unlimited)
    #expect(metered.unlimitedUntil == nil)

    let noFraction = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":0,"units_pending":0,"tier":"vip","unlimited":true,"unlimited_until":"2026-12-25T00:00:00Z",
     "app_account_token":"6f9619ff-8b86-d011-b42d-00c04fc964ff"}
    """#.utf8))
    #expect(noFraction.unlimitedUntil == unlimited.unlimitedUntil)

    let roundTrip = try JSONDecoder().decode(Balance.self, from: JSONEncoder().encode(unlimited))
    #expect(roundTrip == unlimited)
}

// MARK: - Welcome credits

@Test("welcome claim sends the Apple token and maps each 200 status")
func welcomeStatuses() async throws {
    for (status, expected) in [
        ("granted", WelcomeCreditsClaim.Status.granted),
        ("already_claimed", .alreadyClaimed),
        ("welcome_requires_sign_in", .requiresSignIn),
    ] {
        let (client, tearDown) = stubbedClient { request in
            #expect(request.url?.path == "/v1/welcome-grant")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-jwt")
            #expect(request.value(forHTTPHeaderField: "X-App-Id") == "example-app")
            #expect(bodyJSON(request) == ["apple_identity_token": "apple.jwt"])
            let grant = status == "granted" ? #","grant_id":"grant_w","units":10"# : #","units":0"#
            return jsonResponse(request, body: #"{"status":"\#(status)","idempotent":false,"units_available":10,"units_pending":0\#(grant)}"#)
        }
        defer { tearDown() }
        let claim = try await client.claimWelcomeCredits(appleIdentityToken: "apple.jwt").value
        #expect(claim.status == expected)
        #expect(claim.unitsAvailable == 10)
        #expect(claim.grantID == (status == "granted" ? "grant_w" : nil))
        #expect(claim.units == (status == "granted" ? 10 : 0))
    }
}

@Test("welcome claim without a token sends an empty object (Firebase-linked Apple)")
func welcomeWithoutToken() async throws {
    let (client, tearDown) = stubbedClient { request in
        #expect(bodyJSON(request).isEmpty)
        return jsonResponse(request, body: #"{"status":"granted","units":10,"grant_id":"g","idempotent":true,"units_available":10,"units_pending":0}"#)
    }
    defer { tearDown() }
    let claim = try await client.claimWelcomeCredits(appleIdentityToken: nil).value
    #expect(claim.status == .granted)
    #expect(claim.idempotent)
}

@Test("an invalid Apple token maps to appleIdentityTokenInvalid and is not retried")
func welcomeInvalidToken() async throws {
    let calls = Counter()
    let (client, tearDown) = stubbedClient { request in
        calls.increment()
        return errorResponse(request, status: 400, type: "invalid_request", reason: "apple_identity_token_invalid")
    }
    defer { tearDown() }
    await client.setSleepForTesting { _ in Issue.record("must not sleep") }
    do {
        _ = try await client.claimWelcomeCredits(appleIdentityToken: "expired")
        Issue.record("expected an error")
    } catch let error as WelcomeCreditsError {
        #expect(error.code == .appleIdentityTokenInvalid)
        #expect(!error.isRetryable)
        #expect(error.underlying.reason == "apple_identity_token_invalid")
        #expect(error.requestID == "req_test")
    }
}

@Test("provider_unavailable honors Retry-After and retries")
func welcomeRetriesAppleOutage() async throws {
    let calls = Counter()
    let delays = Delays()
    let (client, tearDown) = stubbedClient { request in
        let attempt = calls.syncIncrement()
        if attempt == 1 {
            return errorResponse(request, status: 502, type: "provider_unavailable", reason: "apple_jwks_unavailable", headers: ["Retry-After": "5"])
        }
        return jsonResponse(request, body: #"{"status":"granted","units":10,"grant_id":"g","idempotent":false,"units_available":10,"units_pending":0}"#)
    }
    defer { tearDown() }
    await client.setSleepForTesting { await delays.record($0) }
    let claim = try await client.claimWelcomeCredits(appleIdentityToken: "apple.jwt").value
    #expect(claim.status == .granted)
    #expect(await delays.values == [.seconds(5)])
}

@Test("a lasting Apple outage throws appleUnavailable with Retry-After after maxAttempts")
func welcomeOutageExhausted() async throws {
    let delays = Delays()
    let (client, tearDown) = stubbedClient { request in
        errorResponse(request, status: 502, type: "provider_unavailable", reason: "apple_jwks_unavailable", headers: ["Retry-After": "120"])
    }
    defer { tearDown() }
    await client.setSleepForTesting { await delays.record($0) }
    do {
        _ = try await client.claimWelcomeCredits(appleIdentityToken: "apple.jwt", maxAttempts: 3)
        Issue.record("expected an error")
    } catch let error as WelcomeCreditsError {
        #expect(error.code == .appleUnavailable)
        #expect(error.isRetryable)
        #expect(error.retryAfter == 120)
    }
    // Two waits between three attempts, each capped at 30 seconds.
    #expect(await delays.values == [.seconds(30), .seconds(30)])
}

@Test("welcome claim maps a missing welcome_grant config and passes other errors through")
func welcomeOtherErrors() async throws {
    let (notConfigured, tearDownA) = stubbedClient { request in
        errorResponse(request, status: 404, type: "resource_not_found", reason: "welcome_grant_not_configured")
    }
    defer { tearDownA() }
    await #expect(throws: WelcomeCreditsError.self) {
        _ = try await notConfigured.claimWelcomeCredits(appleIdentityToken: nil)
    }

    let (expired, tearDownB) = stubbedClient { request in
        errorResponse(request, status: 401, type: "invalid_token")
    }
    defer { tearDownB() }
    do {
        _ = try await expired.claimWelcomeCredits(appleIdentityToken: nil)
        Issue.record("expected an error")
    } catch let error as WeirgateError {
        #expect(error.type == .invalidToken)
    }
}

// MARK: - App Store purchases

@Test("redeem sends signed_transaction and decodes the redemption")
func redeemSuccess() async throws {
    let (client, tearDown) = stubbedClient { request in
        #expect(request.url?.path == "/v1/purchases/apple")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "X-App-Id") == "example-app")
        #expect(bodyJSON(request) == ["signed_transaction": "header.payload.signature"])
        return jsonResponse(request, body: #"""
        {"status":"granted","units":100,"grant_id":"grant_p","transaction_id":"2000000123","product_id":"com.example.app.credits.small","environment":"test","units_available":110,"units_pending":0}
        """#)
    }
    defer { tearDown() }
    let redemption = try await client.redeemAppStoreTransaction(jws: "header.payload.signature").value
    #expect(redemption == PurchaseRedemption(
        status: .granted,
        units: 100,
        grantID: "grant_p",
        transactionID: "2000000123",
        productID: "com.example.app.credits.small",
        environment: .test,
        unitsAvailable: 110,
        unitsPending: 0
    ))
}

@Test("already_granted to another user decodes with zero units and no grant ID")
func redeemClaimedByOther() async throws {
    let (client, tearDown) = stubbedClient { request in
        jsonResponse(request, body: #"""
        {"status":"already_granted","units":0,"transaction_id":"2000000123","product_id":"p","environment":"live","units_available":5,"units_pending":0}
        """#)
    }
    defer { tearDown() }
    let redemption = try await client.redeemAppStoreTransaction(jws: "jws").value
    #expect(redemption.status == .alreadyGranted)
    #expect(redemption.units == 0)
    #expect(redemption.grantID == nil)
    #expect(redemption.environment == .live)
}

@Test("every purchase rejection maps to a typed PurchaseRedemptionError")
func redeemErrors() async throws {
    let cases: [(Int, String, String, PurchaseRedemptionError.Code)] = [
        (400, "purchase_invalid_signature", "x5c_chain_invalid", .invalidSignature),
        (422, "purchase_wrong_app", "bundle_id_mismatch", .wrongApp),
        (422, "purchase_environment_mismatch", "environment_not_allowed", .environmentMismatch),
        (422, "purchase_unknown_product", "product_not_mapped", .unknownProduct),
        (409, "purchase_revoked", "transaction_refunded", .revoked),
        (403, "purchase_account_mismatch", "app_account_token_mismatch", .accountMismatch),
        (404, "resource_not_found", "payments_not_configured", .paymentsNotConfigured),
    ]
    for (status, type, reason, code) in cases {
        let (client, tearDown) = stubbedClient { request in
            errorResponse(request, status: status, type: type, reason: reason)
        }
        defer { tearDown() }
        do {
            _ = try await client.redeemAppStoreTransaction(jws: "jws")
            Issue.record("expected \(code)")
        } catch let error as PurchaseRedemptionError {
            #expect(error.code == code)
            #expect(error.reason == reason)
            #expect(error.underlying.statusCode == status)
            #expect(error.shouldFinishTransaction == (code == .revoked))
        }
    }
    #expect(Set(cases.map(\.3)) == Set(PurchaseRedemptionError.Code.allCases))
}

@Test("redeem passes server, auth, and unrelated not-found errors through as WeirgateError")
func redeemPassThrough() async throws {
    for (status, type, reason) in [(500, "internal", nil), (401, "invalid_token", nil), (404, "resource_not_found", nil as String?)] {
        let (client, tearDown) = stubbedClient { request in
            errorResponse(request, status: status, type: type, reason: reason)
        }
        defer { tearDown() }
        do {
            _ = try await client.redeemAppStoreTransaction(jws: "jws")
            Issue.record("expected an error")
        } catch let error as WeirgateError {
            #expect(error.statusCode == status)
            #expect(error.type.rawValue == type)
        }
    }
}

@Test("Retry-After parses delta-seconds and HTTP dates")
func retryAfterParsing() {
    #expect(WeirgateClient.retryAfterSeconds("5") == 5)
    #expect(WeirgateClient.retryAfterSeconds(" 0 ") == 0)
    #expect(WeirgateClient.retryAfterSeconds("soon") == nil)
    #expect(WeirgateClient.retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT") == 0)
}

// MARK: - Balance split and subscriptions

@Test("balance decodes the allowance / purchased split, and derives it when absent")
func balanceSplit() throws {
    let split = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":-30,"units_pending":0,"tier":"pro","unlimited":false,"unlimited_until":null,
     "app_account_token":"6F1C1F9E-4A5B-4D7E-9B3A-2F0F6A1B2C3D","allowance_available":0,"purchased_available":-30}
    """#.utf8))
    #expect(split.allowanceAvailable == 0)
    #expect(split.purchasedAvailable == -30)
    let monthly = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":370,"units_pending":0,"tier":"pro","unlimited":false,"unlimited_until":null,
     "app_account_token":"6F1C1F9E-4A5B-4D7E-9B3A-2F0F6A1B2C3D","allowance_available":120,"purchased_available":250}
    """#.utf8))
    #expect(monthly.allowanceAvailable + monthly.purchasedAvailable == monthly.unitsAvailable)
    #expect(try JSONDecoder().decode(Balance.self, from: JSONEncoder().encode(monthly)) == monthly)
    let older = try JSONDecoder().decode(Balance.self, from: Data(#"""
    {"units_available":40,"units_pending":0,"tier":"free","unlimited":false,"unlimited_until":null,
     "app_account_token":"6F1C1F9E-4A5B-4D7E-9B3A-2F0F6A1B2C3D"}
    """#.utf8))
    #expect(older.allowanceAvailable == 0)
    #expect(older.purchasedAvailable == 40)
}

@Test("a subscription redemption decodes its plan state; consumables default to kind consumable")
func subscriptionRedemption() throws {
    let subscription = try JSONDecoder().decode(PurchaseRedemption.self, from: Data(#"""
    {"status":"granted","kind":"subscription","units":0,"transaction_id":"2000000912345678",
     "original_transaction_id":"2000000912340000","product_id":"com.example.app.pro.monthly","environment":"live",
     "tier":"pro","units_available":500,"units_pending":0,
     "subscription":{"tier":"pro","status":"active","expires_at":"2026-11-04T09:00:00.000Z","active":true,"plan_applied":true}}
    """#.utf8))
    #expect(subscription.kind == .subscription)
    #expect(subscription.originalTransactionID == "2000000912340000")
    #expect(subscription.tier == "pro")
    #expect(subscription.subscription?.status == .active)
    #expect(subscription.subscription?.planApplied == true)
    #expect(subscription.subscription?.expiresAt == Date(timeIntervalSince1970: 1_793_782_800))
    #expect(try JSONDecoder().decode(PurchaseRedemption.self, from: JSONEncoder().encode(subscription)) == subscription)

    let ownedElsewhere = try JSONDecoder().decode(PurchaseRedemption.self, from: Data(#"""
    {"status":"already_granted","kind":"subscription","units":0,"transaction_id":"2","original_transaction_id":"1",
     "product_id":"p","environment":"test","tier":"free","units_available":0,"units_pending":0,"subscription":null}
    """#.utf8))
    #expect(ownedElsewhere.subscription == nil)

    let consumable = try JSONDecoder().decode(PurchaseRedemption.self, from: Data(#"""
    {"status":"granted","units":100,"grant_id":"g","transaction_id":"3","product_id":"credits","environment":"test",
     "units_available":100,"units_pending":0}
    """#.utf8))
    #expect(consumable.kind == .consumable)
    #expect(consumable.subscription == nil)
    #expect(consumable.originalTransactionID == nil)
}

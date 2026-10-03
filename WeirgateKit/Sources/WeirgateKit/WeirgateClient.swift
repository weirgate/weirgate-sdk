import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public actor WeirgateClient {
    private let configuration: WeirgateConfiguration
    private let tokenProvider: WeirgateTokenProvider?
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    private static let maxRetryAfterSeconds: TimeInterval = 30
    private var planCredential: (any PlanCredentialSource)?
    private var fundingPreference: FundingPreference
    /// Feature funding chains from the last catalog read, so a plan credential goes only to
    /// features that accept it (the server rejects it elsewhere with `invalid_request`).
    private var catalogFunding: [String: Feature.Funding] = [:]
    private var catalogReadAt: Date?
    private static let catalogRefreshInterval: TimeInterval = 300
    /// At most this many `next_rail` hops per call.
    private static let maxRailHops = 2

    /// - Parameter planCredential: the end user's plan connection (usually ``PlanConnect``).
    ///   When it has a funding token, chat requests to features that accept its provider send
    ///   it as `X-Weirgate-User-Credential`.
    public init(
        configuration: WeirgateConfiguration,
        tokenProvider: WeirgateTokenProvider? = nil,
        session: URLSession? = nil,
        planCredential: (any PlanCredentialSource)? = nil
    ) {
        self.configuration = configuration
        self.tokenProvider = tokenProvider
        self.session = session ?? Self.ephemeralSession()
        self.planCredential = planCredential
        self.fundingPreference = configuration.fundingPreference
    }

    /// Attach or remove the plan connection used for the `user_plan` rail.
    public func setPlanCredential(_ source: (any PlanCredentialSource)?) {
        planCredential = source
    }

    /// Change the default starting rail for later chat requests.
    public func setFundingPreference(_ preference: FundingPreference) {
        fundingPreference = preference
    }

    public func health() async throws -> WeirgateResponse<Health> {
        let request = try await makeRequest(path: "healthz", method: "GET", authenticated: false)
        return try await execute(request)
    }

    public func features(ifNoneMatch etag: String? = nil) async throws -> CatalogResult {
        var request = try await makeRequest(path: "v1/features", method: "GET")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await performData(request)
        let metadata = try responseMetadata(response)
        let responseETag = response.value(forHTTPHeaderField: "ETag") ?? etag
        if response.statusCode == 304 {
            return .notModified(metadata: metadata, etag: responseETag)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw decodeError(data: data, response: response, metadata: metadata)
        }
        let catalog = try decode(FeatureCatalog.self, data: data, metadata: metadata)
        catalogFunding = Dictionary(
            catalog.data.compactMap { feature in feature.funding.map { (feature.featureID, $0) } },
            uniquingKeysWith: { first, _ in first }
        )
        catalogReadAt = Date()
        return .modified(WeirgateResponse(value: catalog, metadata: metadata), etag: responseETag)
    }

    public func balance() async throws -> WeirgateResponse<Balance> {
        let request = try await makeRequest(path: "v1/balance", method: "GET")
        return try await execute(request)
    }

    /// Claims the app's one-time welcome credits (`POST /v1/welcome-grant`).
    ///
    /// Pass the Sign in with Apple identity token
    /// (`ASAuthorizationAppleIDCredential.identityToken`, UTF-8 decoded). Firebase apps
    /// whose user already has Apple linked pass `nil`: Weirgate reads the linked
    /// `apple.com` identity from the Firebase ID token. Apps configured with
    /// `require: none` also pass `nil`.
    ///
    /// Outcomes are typed statuses on ``WelcomeCreditsClaim/status``. An invalid or
    /// expired Apple token throws ``WelcomeCreditsError`` with
    /// ``WelcomeCreditsError/Code/appleIdentityTokenInvalid``. When Weirgate can't reach
    /// Apple's keys the call waits for `Retry-After` (at most 30 seconds) and tries again,
    /// up to `maxAttempts` in total, then throws
    /// ``WelcomeCreditsError/Code/appleUnavailable``. Retrying is safe: nothing is granted
    /// in that case, and a repeat claim by the same user returns its original grant.
    public func claimWelcomeCredits(
        appleIdentityToken: String?,
        maxAttempts: Int = 2
    ) async throws -> WeirgateResponse<WelcomeCreditsClaim> {
        let body = try encoder.encode(WelcomeCreditsInput(appleIdentityToken: appleIdentityToken))
        var attempt = 1
        while true {
            do {
                let request = try await makeRequest(path: "v1/welcome-grant", method: "POST", body: body)
                return try await execute(request)
            } catch let error as WeirgateError {
                guard let typed = WelcomeCreditsError(error) else { throw error }
                guard typed.isRetryable, attempt < maxAttempts else { throw typed }
                attempt += 1
                try await sleep(.seconds(min(typed.retryAfter ?? 1, Self.maxRetryAfterSeconds)))
            }
        }
    }

    /// Redeems one StoreKit 2 consumable purchase for credits (`POST /v1/purchases/apple`).
    ///
    /// `jws` is `VerificationResult<Transaction>.jwsRepresentation`. Call
    /// `Transaction.finish()` only after this returns (`granted` or `alreadyGranted`), or
    /// after it throws ``PurchaseRedemptionError`` with ``PurchaseRedemptionError/Code/revoked``.
    /// Any other ``PurchaseRedemptionError`` is permanent for that record: leave it
    /// unfinished and don't retry in a loop. Transport errors and 5xx responses are worth
    /// retrying with backoff. `WeirgateStoreKit`'s `WeirgateStoreObserver` applies these
    /// rules for you.
    public func redeemAppStoreTransaction(jws: String) async throws -> WeirgateResponse<PurchaseRedemption> {
        let request = try await makeRequest(
            path: "v1/purchases/apple",
            method: "POST",
            body: encoder.encode(AppStoreRedeemInput(signedTransaction: jws))
        )
        do {
            return try await execute(request)
        } catch let error as WeirgateError {
            throw PurchaseRedemptionError(error) ?? error
        }
    }

    public func deleteAccount() async throws -> WeirgateResponse<AccountDeletionResult> {
        let request = try await makeRequest(path: "v1/account", method: "DELETE")
        return try await execute(request)
    }

    /// A chat completion. The feature's funding chain decides who pays; see
    /// ``FundingPreference`` and ``PlanCredentialSource``. Funding retries happen here:
    /// `user_credential_expired` refreshes the plan once and repeats the request with the
    /// same idempotency key, and `funding_rail_refused` with `next_rail` repeats it once on
    /// that rail. Funding failures throw ``FundingRailError``.
    public func chat(
        featureID: String,
        request input: ChatCompletionRequest,
        options: RequestOptions = .init()
    ) async throws -> WeirgateResponse<ChatCompletion> {
        let body = try encoder.encode(input)
        return try await funded(featureID: featureID, body: body, options: options) { request, _ in
            let (data, response) = try await self.performData(request)
            let metadata = try self.responseMetadata(response, includeFunding: true)
            guard (200..<300).contains(response.statusCode) else {
                throw self.decodeError(data: data, response: response, metadata: metadata)
            }
            let value = WeirgateResponse(value: try self.decode(ChatCompletion.self, data: data, metadata: metadata), metadata: metadata)
            return (value, metadata.funding)
        }
    }

    public func telemetry(
        _ input: ClientTelemetry,
        idempotencyKey: String? = nil
    ) async throws -> WeirgateResponse<Accepted> {
        let request = try await makeRequest(
            path: "v1/telemetry/client",
            method: "POST",
            body: encoder.encode(input),
            options: .init(idempotencyKey: idempotencyKey)
        )
        return try await execute(request)
    }

    /// A streamed chat completion, with the same funding behavior as ``chat(featureID:request:options:)``
    /// before headers. After the stream starts, a rail refusal arrives as the stream's final
    /// error: ``chunks`` throws ``FundingRailError`` (no usage, no `[DONE]`). Discard the
    /// partial answer and call again with ``FundingRailError/retryOptions(from:)``.
    public func streamChat(
        featureID: String,
        request input: ChatCompletionRequest,
        options: RequestOptions = .init()
    ) async throws -> ChatStream {
        let body = try encoder.encode(StreamingChatRequest(request: input))
        return try await funded(featureID: featureID, body: body, options: options) { request, idempotencyKey in
            let stream = try await self.openStream(request, idempotencyKey: idempotencyKey)
            return (stream, stream.metadata.funding)
        }
    }

    private func openStream(_ request: URLRequest, idempotencyKey: String) async throws -> ChatStream {
        let timing = StreamTiming()
        let bytes: URLSession.AsyncBytes
        let rawResponse: URLResponse
        do {
            (bytes, rawResponse) = try await session.bytes(for: request)
        } catch {
            throw WeirgateSDKError.transport(String(describing: type(of: error)))
        }
        guard let response = rawResponse as? HTTPURLResponse else {
            throw WeirgateSDKError.invalidResponse(
                requestID: "unavailable",
                apiVersion: WeirgateKitInfo.apiVersion,
                statusCode: -1
            )
        }
        let metadata = try responseMetadata(response, includeFunding: true)
        guard (200..<300).contains(response.statusCode) else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            throw decodeError(data: data, response: response, metadata: metadata)
        }
        guard response.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("text/event-stream") == true else {
            throw WeirgateSDKError.invalidStream(
                requestID: metadata.requestID,
                apiVersion: metadata.apiVersion,
                reason: "expected text/event-stream"
            )
        }

        let decoder = self.decoder
        let shouldSubmitTelemetry = configuration.automaticallySubmitTelemetry
        let chunks = AsyncThrowingStream<ChatCompletionChunk, Error> { continuation in
            let task = Task {
                var accumulator = SSEContractAccumulator()
                do {
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        if let chunk = try accumulator.consume(line: line, decoder: decoder) {
                            if chunk.choices.contains(where: { $0.delta?.content?.isEmpty == false }) {
                                await timing.recordContent()
                            }
                            continuation.yield(chunk)
                        }
                    }
                    do {
                        try accumulator.validate()
                    } catch {
                        throw WeirgateSDKError.interruptedStream(
                            requestID: metadata.requestID,
                            apiVersion: metadata.apiVersion
                        )
                    }
                    await timing.recordCompletion()
                    if shouldSubmitTelemetry {
                        let snapshot = await timing.snapshot()
                        if let ttft = snapshot.ttftMilliseconds {
                            let telemetry = ClientTelemetry(
                                requestID: metadata.requestID,
                                ttftMilliseconds: ttft,
                                contentCompleteMilliseconds: snapshot.contentCompleteMilliseconds
                            )
                            Task { _ = try? await self.telemetry(telemetry) }
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch let frame as SSEContractAccumulator.ErrorFrame {
                    // A typed refusal after the stream started (x-weirgate-sse mid_stream_error).
                    let error = WeirgateError(
                        type: WeirgateErrorType(rawValue: frame.type) ?? .internalError,
                        statusCode: metadata.statusCode,
                        requestID: frame.requestID ?? metadata.requestID,
                        apiVersion: metadata.apiVersion,
                        serverMessage: frame.message,
                        detail: frame.detail
                    )
                    continuation.finish(throwing: FundingRailError(error, idempotencyKey: idempotencyKey) ?? error)
                } catch let error as WeirgateSDKError {
                    continuation.finish(throwing: error)
                } catch {
                    continuation.finish(throwing: WeirgateSDKError.invalidStream(
                        requestID: metadata.requestID,
                        apiVersion: metadata.apiVersion,
                        reason: "invalid SSE frame"
                    ))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return ChatStream(
            metadata: metadata,
            creditsRemaining: response.value(forHTTPHeaderField: "X-Credits-Remaining").flatMap(Double.init),
            chunks: chunks,
            timing: timing
        )
    }

    /// Runs one funded data-plane call with the plan header injection and retry rules.
    private func funded<Value: Sendable>(
        featureID: String,
        body: Data,
        options: RequestOptions,
        send: (URLRequest, String) async throws -> (Value, FundingOutcome?)
    ) async throws -> Value {
        var idempotencyKey = options.idempotencyKey ?? UUID().uuidString
        var preference = options.funding ?? fundingPreference
        let source = planCredential
        var token = try await planToken(featureID: featureID, preference: preference, source: source)
        var refreshed = false
        var hops = 0
        while true {
            var request = try await makeRequest(
                path: "v1/chat/completions",
                method: "POST",
                body: body,
                options: RequestOptions(idempotencyKey: idempotencyKey, userProviderKey: options.userProviderKey)
            )
            request.setValue(featureID, forHTTPHeaderField: "X-Feature-Id")
            if let header = fundingHeader(featureID: featureID, preference: preference, token: token, source: source) {
                request.setValue(header, forHTTPHeaderField: "X-Weirgate-Funding")
            }
            if let token { request.setValue(token, forHTTPHeaderField: "X-Weirgate-User-Credential") }
            do {
                let (value, outcome) = try await send(request, idempotencyKey)
                if let source, token != nil, let fallback = outcome?.fallback,
                   fallback.disable, fallback.refusedRail == .userPlan {
                    await source.requireReconnect(.railDisabled(reason: fallback.reason))
                }
                return value
            } catch let error as WeirgateError {
                switch error.type {
                case .userCredentialExpired:
                    guard let source, let sent = token else {
                        throw FundingRailError(error, idempotencyKey: idempotencyKey) ?? error
                    }
                    if refreshed {
                        let reason = PlanReconnectReason.credentialRejected(providerCode: error.stringDetail("provider_code"))
                        await source.requireReconnect(reason)
                        throw FundingRailError(code: .reconnectRequired(reason), underlying: error, idempotencyKey: idempotencyKey)
                    }
                    refreshed = true
                    switch try await source.refreshAccessToken(rejected: sent) {
                    case .refreshed(let fresh):
                        token = fresh
                    case .reconnectRequired(let reason):
                        throw FundingRailError(code: .reconnectRequired(reason), underlying: error, idempotencyKey: idempotencyKey)
                    }
                case .fundingRailRefused:
                    guard let next = error.stringDetail("next_rail").map(FundingRail.init(rawValue:)),
                          hops < Self.maxRailHops else {
                        throw FundingRailError(error, idempotencyKey: idempotencyKey) ?? error
                    }
                    hops += 1
                    idempotencyKey = "\(idempotencyKey):rail:\(next.rawValue)"
                    preference = .startAt(next)
                    if next != .userPlan { token = nil }
                case .fundingRailUnavailable:
                    throw FundingRailError(error, idempotencyKey: idempotencyKey) ?? error
                default:
                    throw error
                }
            }
        }
    }

    /// The plan token to send, or `nil` when the preference starts past the plan rail, the
    /// feature does not accept the source's provider, or the plan is not funding.
    private func planToken(
        featureID: String,
        preference: FundingPreference,
        source: (any PlanCredentialSource)?
    ) async throws -> String? {
        guard let source else { return nil }
        if case .startAt(let rail, let provider) = preference {
            guard rail == .userPlan, provider == nil || provider == source.provider else { return nil }
        }
        let accepts = { (funding: Feature.Funding?) in
            funding.map { $0.order.contains(.userPlan) && $0.planProviders.contains(source.provider) } ?? false
        }
        if let known = catalogFunding[featureID] {
            return accepts(known) ? try await source.fundingAccessToken() : nil
        }
        // Read the catalog only when there is a token to send.
        guard let token = try await source.fundingAccessToken() else { return nil }
        return accepts(await featureFunding(featureID)) ? token : nil
    }

    private func fundingHeader(
        featureID: String,
        preference: FundingPreference,
        token: String?,
        source: (any PlanCredentialSource)?
    ) -> String? {
        guard token != nil, let source else { return preference.headerValue }
        switch preference {
        case .startAt:
            return FundingPreference.startAt(.userPlan, provider: source.provider).headerValue
        case .serverChain:
            // The server defaults to the feature's first plan provider; name ours otherwise.
            guard catalogFunding[featureID]?.planProviders.first != source.provider else { return nil }
            return FundingPreference.startAt(.userPlan, provider: source.provider).headerValue
        }
    }

    /// The feature's chain from the catalog, reading the catalog when this feature is unknown
    /// and the last read is stale. A failed read means "no plan" rather than a failed call.
    private func featureFunding(_ featureID: String) async -> Feature.Funding? {
        if let known = catalogFunding[featureID] { return known }
        if let readAt = catalogReadAt, Date().timeIntervalSince(readAt) < Self.catalogRefreshInterval { return nil }
        catalogReadAt = Date()
        _ = try? await features()
        return catalogFunding[featureID]
    }

    private func execute<Value: Decodable & Sendable>(_ request: URLRequest) async throws -> WeirgateResponse<Value> {
        let (data, response) = try await performData(request)
        let metadata = try responseMetadata(response)
        guard (200..<300).contains(response.statusCode) else {
            throw decodeError(data: data, response: response, metadata: metadata)
        }
        return WeirgateResponse(value: try decode(Value.self, data: data, metadata: metadata), metadata: metadata)
    }

    private func performData(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, rawResponse) = try await session.data(for: request)
            guard let response = rawResponse as? HTTPURLResponse else {
                throw WeirgateSDKError.invalidResponse(
                    requestID: "unavailable",
                    apiVersion: WeirgateKitInfo.apiVersion,
                    statusCode: -1
                )
            }
            return (data, response)
        } catch let error as WeirgateSDKError {
            throw error
        } catch {
            throw WeirgateSDKError.transport(String(describing: type(of: error)))
        }
    }

    private func makeRequest(
        path: String,
        method: String,
        authenticated: Bool = true,
        body: Data? = nil,
        options: RequestOptions = .init()
    ) async throws -> URLRequest {
        let url = path.split(separator: "/").reduce(configuration.baseURL) { partial, component in
            partial.appendingPathComponent(String(component))
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = method
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let tokenProvider else {
                throw WeirgateSDKError.invalidConfiguration("An end-user token provider is required")
            }
            request.setValue("Bearer \(try await tokenProvider.token())", forHTTPHeaderField: "Authorization")
            request.setValue(configuration.appID, forHTTPHeaderField: "X-App-Id")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if method != "GET" && method != "HEAD" && method != "OPTIONS" {
            request.setValue(options.idempotencyKey ?? UUID().uuidString, forHTTPHeaderField: "X-Idempotency-Key")
        }
        if let userProviderKey = options.userProviderKey {
            request.setValue(userProviderKey.value, forHTTPHeaderField: "X-User-Provider-Key")
        }
        return request
    }

    private func responseMetadata(_ response: HTTPURLResponse, includeFunding: Bool = false) throws -> ResponseMetadata {
        guard let requestID = response.value(forHTTPHeaderField: "X-Weirgate-Request-Id"),
              let apiVersion = response.value(forHTTPHeaderField: "Weirgate-Api-Version") else {
            throw WeirgateSDKError.invalidResponse(
                requestID: response.value(forHTTPHeaderField: "X-Weirgate-Request-Id") ?? "unavailable",
                apiVersion: response.value(forHTTPHeaderField: "Weirgate-Api-Version") ?? WeirgateKitInfo.apiVersion,
                statusCode: response.statusCode
            )
        }
        return ResponseMetadata(
            requestID: requestID,
            apiVersion: apiVersion,
            statusCode: response.statusCode,
            funding: includeFunding ? FundingOutcome(
                railHeader: response.value(forHTTPHeaderField: "X-Weirgate-Funding-Rail"),
                fallbackHeader: response.value(forHTTPHeaderField: "X-Weirgate-Funding-Fallback")
            ) : nil
        )
    }

    private func decode<Value: Decodable>(
        _ type: Value.Type,
        data: Data,
        metadata: ResponseMetadata
    ) throws -> Value {
        do { return try decoder.decode(type, from: data) }
        catch {
            throw WeirgateSDKError.invalidBody(
                requestID: metadata.requestID,
                apiVersion: metadata.apiVersion,
                statusCode: metadata.statusCode
            )
        }
    }

    private func decodeError(
        data: Data,
        response: HTTPURLResponse,
        metadata: ResponseMetadata
    ) -> WeirgateError {
        let envelope = try? decoder.decode(ErrorEnvelope.self, from: data)
        let headerType = response.value(forHTTPHeaderField: "X-Weirgate-Error-Type")
            .flatMap(WeirgateErrorType.init(rawValue:))
        return WeirgateError(
            type: headerType ?? envelope?.error.type ?? .internalError,
            statusCode: response.statusCode,
            requestID: metadata.requestID,
            apiVersion: metadata.apiVersion,
            serverMessage: envelope?.error.message,
            detail: envelope?.error.detail,
            retryAfter: response.value(forHTTPHeaderField: "Retry-After").flatMap(Self.retryAfterSeconds)
        )
    }

    /// `Retry-After` as delta-seconds or an HTTP date.
    static func retryAfterSeconds(_ value: String) -> TimeInterval? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if let seconds = TimeInterval(trimmed), seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: trimmed).map { max(0, $0.timeIntervalSinceNow) }
    }

    func setSleepForTesting(_ sleep: @escaping @Sendable (Duration) async throws -> Void) {
        self.sleep = sleep
    }

    private nonisolated static func ephemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

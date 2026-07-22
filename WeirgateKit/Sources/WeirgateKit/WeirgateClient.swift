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

    public init(
        configuration: WeirgateConfiguration,
        tokenProvider: WeirgateTokenProvider? = nil,
        session: URLSession? = nil
    ) {
        self.configuration = configuration
        self.tokenProvider = tokenProvider
        self.session = session ?? Self.ephemeralSession()
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
        return .modified(
            WeirgateResponse(value: try decode(FeatureCatalog.self, data: data, metadata: metadata), metadata: metadata),
            etag: responseETag
        )
    }

    public func balance() async throws -> WeirgateResponse<Balance> {
        let request = try await makeRequest(path: "v1/balance", method: "GET")
        return try await execute(request)
    }

    public func chat(
        featureID: String,
        request input: ChatCompletionRequest,
        options: RequestOptions = .init()
    ) async throws -> WeirgateResponse<ChatCompletion> {
        var request = try await makeRequest(
            path: "v1/chat/completions",
            method: "POST",
            body: encoder.encode(input),
            options: options
        )
        request.setValue(featureID, forHTTPHeaderField: "X-Feature-Id")
        return try await execute(request)
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

    public func streamChat(
        featureID: String,
        request input: ChatCompletionRequest,
        options: RequestOptions = .init()
    ) async throws -> ChatStream {
        var request = try await makeRequest(
            path: "v1/chat/completions",
            method: "POST",
            body: encoder.encode(StreamingChatRequest(request: input)),
            options: options
        )
        request.setValue(featureID, forHTTPHeaderField: "X-Feature-Id")

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
        let metadata = try responseMetadata(response)
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

    private func responseMetadata(_ response: HTTPURLResponse) throws -> ResponseMetadata {
        guard let requestID = response.value(forHTTPHeaderField: "X-Weirgate-Request-Id"),
              let apiVersion = response.value(forHTTPHeaderField: "Weirgate-Api-Version") else {
            throw WeirgateSDKError.invalidResponse(
                requestID: response.value(forHTTPHeaderField: "X-Weirgate-Request-Id") ?? "unavailable",
                apiVersion: response.value(forHTTPHeaderField: "Weirgate-Api-Version") ?? WeirgateKitInfo.apiVersion,
                statusCode: response.statusCode
            )
        }
        return ResponseMetadata(requestID: requestID, apiVersion: apiVersion, statusCode: response.statusCode)
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
            detail: envelope?.error.detail
        )
    }

    private nonisolated static func ephemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

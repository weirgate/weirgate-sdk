#if canImport(CryptoKit) && canImport(Security)
import CryptoKit
import Foundation
import Security
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Who signed in, from the OpenID Connect ID token.
public struct PlanIdentity: Codable, Sendable, Equatable {
    /// The provider's opaque, stable subject ID.
    public let subject: String
    public let email: String?
    public let name: String?
    public let picture: String?

    public init(subject: String, email: String? = nil, name: String? = nil, picture: String? = nil) {
        self.subject = subject
        self.email = email
        self.name = name
        self.picture = picture
    }
}

/// A plan connection's tokens as ``PlanConnect`` stores them.
public struct PlanTokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date
    /// The provider may ask the client not to refresh before this time.
    public var earliestRefreshAt: Date?
    public var grantedScopes: [String]
    public var clientID: String
    public var identity: PlanIdentity?
}

/// Where ``PlanConnect`` keeps tokens and the host ID. The default is the Keychain; supply
/// your own to use another protected store. The SDK never writes tokens anywhere else.
public protocol PlanTokenStore: Sendable {
    func load(account: String) async throws -> Data?
    func save(_ data: Data, account: String) async throws
    func delete(account: String) async throws
}

/// Generic-password Keychain items, this device only, available after first unlock, never
/// synced to iCloud.
public struct KeychainPlanTokenStore: PlanTokenStore {
    public let service: String
    public let accessGroup: String?

    public init(service: String = "com.weirgate.plan-connect", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(_ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func load(account: String) async throws -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw PlanConnectError.storage(status) }
        return result as? Data
    }

    public func save(_ data: Data, account: String) async throws {
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(account) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(account).merging(update) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PlanConnectError.storage(status) }
    }

    public func delete(account: String) async throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PlanConnectError.storage(status) }
    }
}

/// Keeps everything in memory, for tests and previews. Nothing survives the process.
public actor InMemoryPlanTokenStore: PlanTokenStore {
    private var items: [String: Data] = [:]
    public init() {}
    public func load(account: String) async throws -> Data? { items[account] }
    public func save(_ data: Data, account: String) async throws { items[account] = data }
    public func delete(account: String) async throws { items[account] = nil }
}

/// Presents the provider's sign-in page and returns the redirect it ends on.
/// ``WebAuthenticationSessionAuthorizer`` does this with `ASWebAuthenticationSession`.
public protocol PlanAuthorizer: Sendable {
    func authorize(url: URL, redirectURI: URL) async throws -> URL
}

public enum PlanConnectionStatus: Sendable, Equatable {
    case disconnected
    /// Signed in. `funding` is false when the user did not grant plan usage
    /// (`chatgpt.tokens.use.direct`): keep the sign-in for identity and offer
    /// ``PlanConnect/enablePlanUsage()``.
    case connected(identity: PlanIdentity?, funding: Bool)
    /// The tokens were cleared; offer the connect button again.
    case reconnectRequired(PlanReconnectReason)
}

public enum PlanConnectError: LocalizedError, Sendable, Equatable {
    /// The user closed the sign-in sheet.
    case cancelled
    /// The provider redirected back with `error=` (for example `access_denied`).
    case authorizationDenied(String)
    case stateMismatch
    case missingCode
    /// The token endpoint answered with an error that is not a refusal of the refresh token.
    case tokenEndpoint(status: Int, error: String?)
    case invalidTokenResponse
    case invalidIDToken(String)
    case invalidConfiguration(String)
    case storage(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .cancelled: "Sign-in was cancelled."
        case .authorizationDenied(let error): "Sign-in was not completed (\(error))."
        case .stateMismatch: "Sign-in returned an unexpected state."
        case .missingCode: "Sign-in returned no authorization code."
        case .tokenEndpoint(let status, let error): "The sign-in service returned \(error ?? "an error") (HTTP \(status))."
        case .invalidTokenResponse: "The sign-in service returned an invalid token response."
        case .invalidIDToken(let reason): "The ID token failed validation: \(reason)."
        case .invalidConfiguration(let message): message
        case .storage(let status): "The Keychain returned \(status)."
        }
    }
}

/// Connects the end user's AI plan for the `user_plan` funding rail: OpenID Connect with
/// PKCE, tokens in the Keychain, proactive and rotating refresh. Pass it to
/// ``WeirgateClient`` as the plan credential; the client sends the access token per request
/// and asks this object to refresh or disconnect when Weirgate rejects it.
///
/// Refreshes are serialized, so concurrent requests never race a rotating refresh token.
public actor PlanConnect: PlanCredentialSource {
    public struct Configuration: Sendable {
        public var provider: PlanProvider
        /// The client ID from the app's partner registration with the provider.
        public var clientID: String
        /// A redirect URI registered for that client: a custom scheme (`myapp://oauth/chatgpt`)
        /// or a universal link (`https`, needs iOS 17.4 / macOS 14.4).
        public var redirectURI: URL
        public var scopes: [String]
        /// The scope that lets the app spend the user's plan.
        public var planUsageScope: String
        public var issuer: String
        public var authorizationEndpoint: URL
        public var tokenEndpoint: URL
        /// Where to revoke the refresh token on disconnect; when `nil`, read from
        /// ``discoveryURL``'s `revocation_endpoint`.
        public var revocationEndpoint: URL?
        public var discoveryURL: URL?
        public var resource: String?
        /// Your app's name, shown on the provider's consent screen at first sign-in.
        public var agentNameHint: String?
        /// Refresh when fewer than this many seconds remain on the access token.
        public var refreshMargin: TimeInterval

        public init(
            provider: PlanProvider,
            clientID: String,
            redirectURI: URL,
            scopes: [String],
            planUsageScope: String,
            issuer: String,
            authorizationEndpoint: URL,
            tokenEndpoint: URL,
            revocationEndpoint: URL? = nil,
            discoveryURL: URL? = nil,
            resource: String? = nil,
            agentNameHint: String? = nil,
            refreshMargin: TimeInterval = 300
        ) {
            self.provider = provider
            self.clientID = clientID
            self.redirectURI = redirectURI
            self.scopes = scopes
            self.planUsageScope = planUsageScope
            self.issuer = issuer
            self.authorizationEndpoint = authorizationEndpoint
            self.tokenEndpoint = tokenEndpoint
            self.revocationEndpoint = revocationEndpoint
            self.discoveryURL = discoveryURL
            self.resource = resource
            self.agentNameHint = agentNameHint
            self.refreshMargin = refreshMargin
        }

        /// Sign in with ChatGPT for a partner-registered app (endpoints as documented by
        /// OpenAI on 2026-10-03). `clientID` and `redirectURI` come from your registration.
        public static func openAIChatGPT(
            clientID: String,
            redirectURI: URL,
            agentNameHint: String? = nil
        ) -> Configuration {
            Configuration(
                provider: .openAIChatGPT,
                clientID: clientID,
                redirectURI: redirectURI,
                scopes: ["openid", "profile", "email", "offline_access", "chatgpt.tokens.use.direct"],
                planUsageScope: "chatgpt.tokens.use.direct",
                issuer: "https://auth.openai.com",
                authorizationEndpoint: URL(string: "https://auth.openai.com/api/accounts/authorize")!,
                tokenEndpoint: URL(string: "https://auth.openai.com/api/accounts/oauth/token")!,
                discoveryURL: URL(string: "https://auth.openai.com/.well-known/openid-configuration"),
                resource: "https://api.openai.com/v1",
                agentNameHint: agentNameHint
            )
        }
    }

    private struct Record: Codable {
        var tokens: PlanTokens? = nil
        var reconnectReason: PlanReconnectReason? = nil
    }

    public nonisolated let provider: PlanProvider
    public let configuration: Configuration
    private let store: any PlanTokenStore
    private let authorizer: any PlanAuthorizer
    private let session: URLSession
    private let now: @Sendable () -> Date
    private var record: Record?
    private var refreshing: Task<PlanRefreshResult, Error>?
    private var observers: [UUID: AsyncStream<PlanConnectionStatus>.Continuation] = [:]

    public init(
        configuration: Configuration,
        authorizer: any PlanAuthorizer,
        store: (any PlanTokenStore)? = nil,
        session: URLSession? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.provider = configuration.provider
        self.configuration = configuration
        self.authorizer = authorizer
        self.store = store ?? KeychainPlanTokenStore()
        self.session = session ?? {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            return URLSession(configuration: configuration)
        }()
        self.now = now
    }

    private var tokensAccount: String { "\(provider.rawValue).tokens" }
    private var hostIDAccount: String { "\(provider.rawValue).host_id" }

    // MARK: Status

    public func status() async throws -> PlanConnectionStatus {
        Self.status(of: try await loadRecord(), planUsageScope: configuration.planUsageScope)
    }

    /// Emits the current status, then every change (connect, refresh refusal, reconnect
    /// required, disconnect). Use it to show or hide "Reconnect" without polling.
    public func statusUpdates() async -> AsyncStream<PlanConnectionStatus> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<PlanConnectionStatus>.makeStream()
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        let current = (try? await loadRecord()) ?? Record()
        continuation.yield(Self.status(of: current, planUsageScope: configuration.planUsageScope))
        return stream
    }

    private func removeObserver(_ id: UUID) { observers[id] = nil }

    private static func status(of record: Record, planUsageScope: String) -> PlanConnectionStatus {
        if let tokens = record.tokens {
            return .connected(identity: tokens.identity, funding: tokens.grantedScopes.contains(planUsageScope))
        }
        if let reason = record.reconnectReason { return .reconnectRequired(reason) }
        return .disconnected
    }

    // MARK: Host ID

    /// A stable opaque ID for this install (`urn:uuid:…`), created before the first sign-in
    /// and sent as `ext_agent_host_id` on every authorization. Kept in the token store.
    public func hostID() async throws -> String {
        if let data = try await store.load(account: hostIDAccount), let value = String(data: data, encoding: .utf8) {
            return value
        }
        let value = "urn:uuid:\(UUID().uuidString.lowercased())"
        try await store.save(Data(value.utf8), account: hostIDAccount)
        return value
    }

    // MARK: Connect

    /// Signs the user in. Check the returned status: `.connected(funding: false)` means the
    /// user declined plan usage; the sign-in still identifies them.
    @discardableResult
    public func connect() async throws -> PlanConnectionStatus {
        try await authorize(prompt: nil)
    }

    /// Repeats sign-in with `prompt=consent` so the user can grant plan usage they declined.
    @discardableResult
    public func enablePlanUsage() async throws -> PlanConnectionStatus {
        try await authorize(prompt: "consent")
    }

    /// Revokes the refresh token (best effort) and clears the stored tokens. The host ID stays.
    public func disconnect() async throws {
        let refreshToken = try await loadRecord().tokens?.refreshToken
        try await persist(Record(tokens: nil, reconnectReason: nil))
        if let refreshToken, let revocation = await revocationEndpoint() {
            var request = URLRequest(url: revocation)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.form([
                ("token", refreshToken),
                ("token_type_hint", "refresh_token"),
                ("client_id", configuration.clientID),
            ])
            _ = try? await session.data(for: request)
        }
    }

    private func revocationEndpoint() async -> URL? {
        if let endpoint = configuration.revocationEndpoint { return endpoint }
        guard let discovery = configuration.discoveryURL,
              let (data, _) = try? await session.data(from: discovery),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = json["revocation_endpoint"] as? String else { return nil }
        return URL(string: value)
    }

    private func authorize(prompt: String?) async throws -> PlanConnectionStatus {
        let verifier = Self.randomURLSafe(bytes: 32)
        let state = Self.randomURLSafe(bytes: 16)
        let nonce = Self.randomURLSafe(bytes: 16)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var items: [URLQueryItem] = [
            .init(name: "client_id", value: configuration.clientID),
            .init(name: "response_type", value: "code"),
            .init(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            .init(name: "scope", value: configuration.scopes.joined(separator: " ")),
            .init(name: "state", value: state),
            .init(name: "nonce", value: nonce),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "ext_agent_host_id", value: try await hostID()),
        ]
        if let resource = configuration.resource { items.append(.init(name: "resource", value: resource)) }
        if let prompt { items.append(.init(name: "prompt", value: prompt)) }
        if let hint = configuration.agentNameHint { items.append(.init(name: "agent_name_hint", value: hint)) }
        if let email = try await loadRecord().tokens?.identity?.email { items.append(.init(name: "login_hint", value: email)) }
        guard var components = URLComponents(url: configuration.authorizationEndpoint, resolvingAgainstBaseURL: false) else {
            throw PlanConnectError.invalidConfiguration("authorizationEndpoint is not a valid URL")
        }
        components.queryItems = (components.queryItems ?? []) + items
        guard let url = components.url else { throw PlanConnectError.invalidConfiguration("could not build the authorization URL") }

        let callback = try await authorizer.authorize(url: url, redirectURI: configuration.redirectURI)
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        guard value("state") == state else { throw PlanConnectError.stateMismatch }
        if let error = value("error") { throw PlanConnectError.authorizationDenied(error) }
        guard let code = value("code") else { throw PlanConnectError.missingCode }

        var form = [
            ("grant_type", "authorization_code"),
            ("client_id", configuration.clientID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", configuration.redirectURI.absoluteString),
        ]
        if let resource = configuration.resource { form.append(("resource", resource)) }
        let (status, json) = try await postForm(form)
        guard status == 200 else { throw PlanConnectError.tokenEndpoint(status: status, error: json?["error"] as? String) }
        guard let json else { throw PlanConnectError.invalidTokenResponse }
        var tokens = try tokens(from: json, previous: nil)
        guard let idToken = json["id_token"] as? String else { throw PlanConnectError.invalidIDToken("missing") }
        tokens.identity = try validateIDToken(idToken, nonce: nonce)
        try await persist(Record(tokens: tokens, reconnectReason: nil))
        return Self.status(of: Record(tokens: tokens), planUsageScope: configuration.planUsageScope)
    }

    // MARK: PlanCredentialSource

    public func fundingAccessToken() async throws -> String? {
        guard let tokens = try await loadRecord().tokens,
              tokens.grantedScopes.contains(configuration.planUsageScope) else { return nil }
        let remaining = tokens.expiresAt.timeIntervalSince(now())
        let mayRefresh = tokens.refreshToken != nil && tokens.earliestRefreshAt.map { now() >= $0 } != false
        guard remaining < configuration.refreshMargin, mayRefresh else { return tokens.accessToken }
        do {
            switch try await refresh() {
            case .refreshed(let token): return token
            case .reconnectRequired: return nil
            }
        } catch where remaining > 0 {
            // A transient refresh failure: the current token is still valid for now.
            return tokens.accessToken
        }
    }

    public func refreshAccessToken(rejected: String) async throws -> PlanRefreshResult {
        let record = try await loadRecord()
        guard let tokens = record.tokens else {
            return .reconnectRequired(record.reconnectReason ?? .credentialRejected(providerCode: nil))
        }
        // Another request already replaced the rejected token.
        if tokens.accessToken != rejected { return .refreshed(tokens.accessToken) }
        guard tokens.refreshToken != nil else {
            let reason = PlanReconnectReason.credentialRejected(providerCode: nil)
            await requireReconnect(reason)
            return .reconnectRequired(reason)
        }
        return try await refresh()
    }

    public func requireReconnect(_ reason: PlanReconnectReason) async {
        try? await persist(Record(tokens: nil, reconnectReason: reason))
    }

    // MARK: Refresh

    private func refresh() async throws -> PlanRefreshResult {
        if let refreshing { return try await refreshing.value }
        let task = Task { try await self.performRefresh() }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private func performRefresh() async throws -> PlanRefreshResult {
        guard let current = try await loadRecord().tokens, let refreshToken = current.refreshToken else {
            return .reconnectRequired(.credentialRejected(providerCode: nil))
        }
        var form = [
            ("grant_type", "refresh_token"),
            ("client_id", current.clientID),
            ("refresh_token", refreshToken),
        ]
        if let resource = configuration.resource { form.append(("resource", resource)) }
        let (status, json) = try await postForm(form)
        if status == 200, let json {
            let tokens = try tokens(from: json, previous: current)
            try await persist(Record(tokens: tokens, reconnectReason: nil))
            return .refreshed(tokens.accessToken)
        }
        let error = json?["error"] as? String
        if let error, Self.refreshRefusals.contains(error) {
            let reason = PlanReconnectReason.refreshRejected(oauthError: error)
            await requireReconnect(reason)
            return .reconnectRequired(reason)
        }
        if error == "invalid_client" {
            throw PlanConnectError.invalidConfiguration("the provider rejected the client ID (invalid_client)")
        }
        throw PlanConnectError.tokenEndpoint(status: status, error: error)
    }

    /// Refresh errors after which the stored tokens can never work again (OpenAI's recovery
    /// guide): clear them and ask the user to sign in again.
    static let refreshRefusals: Set<String> = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_reused"]

    // MARK: Helpers

    private func tokens(from json: [String: Any], previous: PlanTokens?) throws -> PlanTokens {
        guard let accessToken = json["access_token"] as? String, !accessToken.isEmpty else {
            throw PlanConnectError.invalidTokenResponse
        }
        let expiresIn = (json["expires_in"] as? NSNumber)?.doubleValue ?? 3600
        let earliest = (json["earliest_refresh_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
            ?? (json["earliest_refresh_at"] as? String).flatMap { try? Date.ISO8601FormatStyle().parse($0) }
        let scopes = (json["scope"] as? String).map(Self.split)
            ?? (Self.jwtClaims(accessToken)?["scope"] as? String).map(Self.split)
            ?? previous?.grantedScopes
            ?? []
        return PlanTokens(
            accessToken: accessToken,
            // Refresh tokens rotate: store the replacement every time one is returned.
            refreshToken: (json["refresh_token"] as? String) ?? previous?.refreshToken,
            expiresAt: now().addingTimeInterval(expiresIn),
            earliestRefreshAt: earliest,
            grantedScopes: scopes,
            clientID: previous?.clientID ?? configuration.clientID,
            identity: previous?.identity
        )
    }

    /// The ID token comes straight from the token endpoint over TLS, so per OpenID Connect
    /// Core §3.1.3.7 the TLS server check stands in for the signature; the claims are
    /// still checked.
    private func validateIDToken(_ token: String, nonce: String) throws -> PlanIdentity {
        guard let claims = Self.jwtClaims(token) else { throw PlanConnectError.invalidIDToken("unreadable") }
        guard (claims["iss"] as? String)?.trimmingSuffix("/") == configuration.issuer.trimmingSuffix("/") else {
            throw PlanConnectError.invalidIDToken("issuer")
        }
        let audience = (claims["aud"] as? [String]) ?? (claims["aud"] as? String).map { [$0] } ?? []
        guard audience.contains(configuration.clientID) else { throw PlanConnectError.invalidIDToken("audience") }
        guard claims["nonce"] as? String == nonce else { throw PlanConnectError.invalidIDToken("nonce") }
        if let exp = (claims["exp"] as? NSNumber)?.doubleValue, Date(timeIntervalSince1970: exp) < now() {
            throw PlanConnectError.invalidIDToken("expired")
        }
        guard let subject = claims["sub"] as? String else { throw PlanConnectError.invalidIDToken("subject") }
        return PlanIdentity(
            subject: subject,
            email: claims["email"] as? String,
            name: claims["name"] as? String,
            picture: claims["picture"] as? String
        )
    }

    private func postForm(_ fields: [(String, String)]) async throws -> (Int, [String: Any]?) {
        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Self.form(fields)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func loadRecord() async throws -> Record {
        if let record { return record }
        let loaded = try await store.load(account: tokensAccount).flatMap { try? JSONDecoder().decode(Record.self, from: $0) }
            ?? Record()
        record = loaded
        return loaded
    }

    private func persist(_ next: Record) async throws {
        if next.tokens == nil && next.reconnectReason == nil {
            try await store.delete(account: tokensAccount)
        } else {
            try await store.save(JSONEncoder().encode(next), account: tokensAccount)
        }
        let changed = record.map { Self.status(of: $0, planUsageScope: configuration.planUsageScope) }
            != Self.status(of: next, planUsageScope: configuration.planUsageScope)
        record = next
        if changed {
            let status = Self.status(of: next, planUsageScope: configuration.planUsageScope)
            for continuation in observers.values { continuation.yield(status) }
        }
    }

    static func form(_ fields: [(String, String)]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return Data(fields.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
        }.joined(separator: "&").utf8)
    }

    static func randomURLSafe(bytes count: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func jwtClaims(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func split(_ scopes: String) -> [String] {
        scopes.split(separator: " ").map(String.init)
    }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
#endif

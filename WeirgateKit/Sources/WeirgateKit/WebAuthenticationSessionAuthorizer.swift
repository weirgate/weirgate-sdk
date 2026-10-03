#if canImport(AuthenticationServices)
import AuthenticationServices
import Foundation

/// Presents the provider's sign-in page with `ASWebAuthenticationSession`.
///
/// Redirect URIs with a custom scheme work on every supported OS. Universal-link (`https`)
/// redirects need iOS 17.4 or macOS 14.4.
@MainActor
public final class WebAuthenticationSessionAuthorizer: NSObject, PlanAuthorizer, ASWebAuthenticationPresentationContextProviding {
    private let anchor: @MainActor () -> ASPresentationAnchor
    private let prefersEphemeralWebBrowserSession: Bool
    private var session: ASWebAuthenticationSession?

    /// - Parameters:
    ///   - prefersEphemeralWebBrowserSession: `true` skips shared browser cookies, so the user
    ///     always types their credentials.
    ///   - anchor: the window to present from (for example the key window of the active scene).
    public init(
        prefersEphemeralWebBrowserSession: Bool = false,
        anchor: @escaping @MainActor () -> ASPresentationAnchor
    ) {
        self.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
        self.anchor = anchor
    }

    public func authorize(url: URL, redirectURI: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let completion: @Sendable (URL?, Error?) -> Void = { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: PlanConnectError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? PlanConnectError.cancelled)
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, macOS 14.4, *) {
                let callback: ASWebAuthenticationSession.Callback
                if redirectURI.scheme == "https", let host = redirectURI.host() {
                    callback = .https(host: host, path: redirectURI.path())
                } else {
                    callback = .customScheme(redirectURI.scheme ?? "")
                }
                session = ASWebAuthenticationSession(url: url, callback: callback, completionHandler: completion)
            } else if redirectURI.scheme == "https" {
                continuation.resume(throwing: PlanConnectError.invalidConfiguration(
                    "An https redirect URI needs iOS 17.4 or macOS 14.4; register a custom-scheme redirect instead"
                ))
                return
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: redirectURI.scheme, completionHandler: completion)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
            self.session = session
            if !session.start() {
                continuation.resume(throwing: PlanConnectError.invalidConfiguration("The sign-in session could not start"))
            }
        }
    }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor() }
    }
}
#endif

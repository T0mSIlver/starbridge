import CryptoKit
import Foundation
import StarbridgeProtocol

/**
 * GitHub sign-in for the app, with PKCE (RFC 7636, PROTOCOL.md "Auth"), as on Android. GitHub
 * binds its code to the challenge, so whoever catches the redirect, trading the code for a
 * session needs the verifier, which never leaves this iPhone.
 */
enum SignIn {
    /** 32 random bytes, base64url without padding: 43 characters. */
    static func newVerifier() -> String { toB64(Sodium.randomBytes(32)) }

    static func challenge(_ verifier: String) -> String { toB64(Array(SHA256.hash(data: Data(verifier.utf8)))) }

    static func url(server: String, verifier: String) -> URL? {
        URL(string: "\(server)/v1/auth/github?app=1&challenge=\(challenge(verifier))")
    }

    /**
     * The https page where a sign-in on `server` ends, for the browser sheet to catch from iOS
     * 17.4, else nil. Only starbridge.run lists this app in its apple-app-site-association, so a
     * self-hosted server's sign-in ends on starbridge://auth.
     */
    static func httpsCallback(server: String) -> (host: String, path: String)? {
        guard let parts = URLComponents(string: server), parts.scheme == "https", parts.host == "starbridge.run",
              parts.port == nil, parts.path.isEmpty || parts.path == "/" else { return nil }
        return ("starbridge.run", "/v1/auth/github/callback/app")
    }

    /** What ends a sign-in. */
    enum Redirect: Equatable {
        /** The code to trade, and the sign-in's state: its challenge. */
        case code(String, state: String)
        /** The owner turned GitHub down, or GitHub failed. */
        case denied(state: String)
    }

    /**
     * The sign-in a link ends, else nil: starbridge://auth, where the server hands GitHub's code
     * on, or the https pages Android catches as App Links (PROTOCOL.md, "Auth"), so a link
     * opened from either reads the same.
     */
    static func redirect(_ link: URL) -> Redirect? {
        guard let parts = URLComponents(url: link, resolvingAgainstBaseURL: false) else { return nil }
        let hosted = parts.scheme == "https" && parts.host == "starbridge.run"
            && (parts.path == "/v1/auth/github/callback/app" || parts.path == "/app/auth")
        guard hosted || (parts.scheme == "starbridge" && parts.host == "auth") else { return nil }
        var query: [String: String] = [:]
        for item in parts.queryItems ?? [] where query[item.name] == nil {
            if let value = item.value, !value.isEmpty { query[item.name] = value }
        }
        guard let state = query["state"] else { return nil }
        if let code = query["code"] { return .code(code, state: state) }
        if query["error"] != nil { return .denied(state: state) }
        return nil
    }
}

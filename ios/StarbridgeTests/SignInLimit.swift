import Foundation
@testable import Starbridge

/**
 * The suite signs in as the owner more often than the server's 10 sign-ins a minute: these wait
 * out the limit, as its Retry-After says, rather than failing the test that comes next.
 */
extension Api {
    func ownerSession(token: String) async throws -> String {
        for _ in 0..<3 {
            do {
                return try await ownerSignIn(token: token)
            } catch let e as ApiError where e.status == 429 {
                try await Api.waitOutLimit()
            }
        }
        return try await ownerSignIn(token: token)
    }

    /** Sleeps until the hold a 429's Retry-After set has passed. */
    static func waitOutLimit() async throws {
        let left = limitedUntil.withLock { $0 }.timeIntervalSinceNow
        try await Task.sleep(for: .seconds(max(1, left + 1)))
    }
}

extension Store {
    func signInWaiting(server: String, token: String) async {
        for _ in 0..<3 {
            await signInWithOwnerToken(server: server, token: token)
            guard phase == .signedOut, notice == "Too many tries. Wait a minute and try again." else { return }
            try? await Api.waitOutLimit()
        }
    }
}

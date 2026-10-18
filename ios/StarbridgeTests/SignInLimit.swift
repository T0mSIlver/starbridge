import Foundation
@testable import Starbridge

/**
 * The test server raises the owner sign-in limit (ios.yml, README.md), since the suite signs in as
 * the one owner account more often than the default 10 a minute. If a run still meets the limit,
 * these wait it out, as its Retry-After says, rather than failing the test that comes next.
 */
extension Api {
    func ownerSession(token: String) async throws -> String {
        for _ in 0..<3 {
            do {
                return try await ownerSignIn(token: token)
            } catch let e as ApiError where e.status == 429 {
                try await Api.waitOutLimit()
            } catch let e as URLError where e.code == .timedOut {
                // A sign-in is safe to repeat: one slow answer from the shared server failed a test (#1915).
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

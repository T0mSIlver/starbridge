import XCTest
@testable import Starbridge

/** Answers each request with the next scripted reply: a status and body, or a URL error. */
final class OwnerReplies: URLProtocol, @unchecked Sendable {
    enum Reply { case status(Int, String), failure(URLError.Code) }
    nonisolated(unsafe) static var replies: [Reply] = []
    nonisolated(unsafe) static var hosts: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        OwnerReplies.hosts.append(request.url?.host ?? "")
        switch OwnerReplies.replies.isEmpty ? .status(404, "") : OwnerReplies.replies.removeFirst() {
        case let .status(code, body):
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: [:])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case let .failure(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}
}

/**
 * What an owner-token sign-in that fails says: the reason in the app's words, never the API's
 * code (#2085, as Android's OwnerTokenSignInTest).
 */
@MainActor
final class OwnerTokenSignInTests: XCTestCase {
    private let server = "https://sb.example.test"

    override func setUp() {
        OwnerReplies.replies = []
        OwnerReplies.hosts = []
        Api.limitedUntil.withLock { $0 = .distantPast }
    }

    private func store() -> Store {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OwnerReplies.self]
        return Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "iPhone", http: URLSession(configuration: config))
    }

    /** Signs in with the scripted replies and returns the notice the sign-in left. */
    private func signIn(_ replies: OwnerReplies.Reply..., server: String? = nil) async -> String? {
        OwnerReplies.replies = replies
        let store = store()
        await store.signInWithOwnerToken(server: server ?? self.server, token: "token")
        XCTAssertEqual(store.phase, .signedOut)
        return store.notice
    }

    func testAWrongTokenSaysSo() async {
        let said = await signIn(.status(401, #"{"error":"unauthenticated","detail":"wrong owner token"}"#))
        XCTAssertEqual(said, "Wrong owner token.")
    }

    func testAServerWithoutOwnerSignInSaysSo() async {
        let said = await signIn(.status(404, #"{"error":"not-configured","detail":"owner sign-in is off on this server"}"#))
        XCTAssertEqual(said, "sb.example.test doesn't take an owner token.")
    }

    func testAnotherWebsiteIsNoStarbridgeServer() async {
        let said = await signIn(.status(200, "<html>hello</html>"))
        XCTAssertEqual(said, "No Starbridge server at sb.example.test.")
    }

    func testAPageNotFoundIsNoStarbridgeServer() async {
        let said = await signIn(.status(404, "<html>not found</html>"))
        XCTAssertEqual(said, "No Starbridge server at sb.example.test.")
    }

    func testAServerThatDoesNotAnswerInTimeSaysSo() async {
        let said = await signIn(.failure(.timedOut))
        XCTAssertEqual(said, "sb.example.test didn't answer in time.")
    }

    func testAnAddressWithoutASchemeGetsHttps() async {
        let store = store()
        OwnerReplies.replies = [.status(401, #"{"error":"unauthenticated"}"#)]
        await store.signInWithOwnerToken(server: " demo.example.test/ ", token: "token")
        // As typed in a browser: https is the default, not an error about the URL's scheme.
        XCTAssertEqual(store.saved.server, "https://demo.example.test")
        XCTAssertEqual(OwnerReplies.hosts, ["demo.example.test"])
        XCTAssertEqual(store.notice, "Wrong owner token.")
    }

    func testAnAddressThatIsNoAddress() async {
        let said = await signIn(server: "https://demo example")
        XCTAssertEqual(said, "That server address isn't valid.")
        XCTAssertEqual(OwnerReplies.hosts, [])
    }

    func testANewTryEndsTheLastFailure() async {
        let store = store()
        OwnerReplies.replies = [
            .status(401, #"{"error":"unauthenticated"}"#),
            .status(200, #"{"session":"s"}"#),
            .status(200, #"{"account":"acct","member":null,"role":"device"}"#),
            .status(200, #"{"entries":[]}"#),
        ]
        await store.signInWithOwnerToken(server: server, token: "wrong")
        XCTAssertEqual(store.notice, "Wrong owner token.")
        await store.signInWithOwnerToken(server: server, token: "token")
        // Gone, so it doesn't follow the owner to the next screen as an alert.
        XCTAssertEqual(store.phase, .noDevice(accountExists: false))
        XCTAssertNil(store.notice)
    }

    func testAnotherSignInsLinkLeavesTheFailureOnScreen() async throws {
        let store = store()
        OwnerReplies.replies = [.status(401, #"{"error":"unauthenticated"}"#)]
        await store.signInWithOwnerToken(server: server, token: "wrong")
        _ = store.gitHubSignInURL(server: server)
        await store.receiveSignIn(try XCTUnwrap(URL(string: "starbridge://auth?code=c1&state=someone-else")))
        await store.receiveSignIn(try XCTUnwrap(URL(string: "starbridge://pair?server=x&k=y#code")))
        XCTAssertEqual(store.notice, "Wrong owner token.")
    }

    func testGitHubOnAServerWithoutASchemeGoesToHttps() throws {
        // Self-hosted GitHub sign-in reads the address the same way.
        let url = try XCTUnwrap(store().gitHubSignInURL(server: "demo.example.test/"))
        XCTAssertTrue(url.absoluteString.hasPrefix("https://demo.example.test/v1/auth/github?"), url.absoluteString)
    }
}

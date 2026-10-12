import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * A server for one queued answer: the directory reads empty, each POST /items takes the next
 * scripted reply (201 once none is left), and every other read fails.
 */
final class AnswerServer: URLProtocol, @unchecked Sendable {
    /** A status and its headers, or nil for no connection. */
    nonisolated(unsafe) static var posts: [(Int, [String: String])?] = []
    nonisolated(unsafe) static var posted = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path() ?? ""
        var status = 500
        var headers = ["Content-Type": "application/json"]
        var body = #"{"error":"internal"}"#
        if request.httpMethod == "POST" && path.hasSuffix("/v1/items") {
            AnswerServer.posted += 1
            guard let reply = AnswerServer.posts.isEmpty ? (201, [:]) : AnswerServer.posts.removeFirst() else {
                client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
                return
            }
            status = reply.0
            headers.merge(reply.1) { $1 }
            body = status == 201 ? "{}" : #"{"error":"rate-limited"}"#
        } else if path.hasSuffix("/v1/directory") {
            status = 200
            body = #"{"entries":[]}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/** An answer the server could not take goes out without a pull (#1392). */
@MainActor
final class AnswerRetryTests: XCTestCase {
    override func setUp() {
        AnswerServer.posts = []
        AnswerServer.posted = 0
        Api.limitedUntil.withLock { $0 = .distantPast }
    }

    override func tearDown() { Api.limitedUntil.withLock { $0 = .distantPast } }

    /** This iPhone with the machine's open question "Merge the inbox PR?", its directory read. */
    private func store() async throws -> Store {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let f = try NotifyFixture()
        let body: JSON = [
            "v": 1, "id": "d_one", "to": [.string(f.phone.id)], "createdAt": .string(Dates.format(Date())), "question": "Merge the inbox PR?",
            "context": "", "options": ["Merge", "Wait"], "recommended": "Wait", "source": NotifyFixture.source,
        ]
        var saved = f.saved
        saved.decisions = [try SavedDecision(from: f.machine.id, text: body.text, answeredAt: nil)]
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let vault = MemoryVault()
        vault.secrets = f.secrets
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AnswerServer.self]
        let store = Store(vault: vault, disk: disk, deviceName: "Test iPhone", http: URLSession(configuration: config))
        addTeardownBlock { @MainActor in store.answerRetry?.cancel() }
        try await store.serial { try await store.syncDirectory() }
        return store
    }

    private func until(_ seconds: Double = 5, _ done: () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !done() && Date() < end { try await Task.sleep(for: .milliseconds(50)) }
    }

    func testAnAnswerRefusedDuringARateLimitHoldIsSentOnceTheHoldEnds() async throws {
        let store = try await store()
        // The server's limit says to come back in a minute: past the 20 s a call waits.
        AnswerServer.posts = [(429, ["Retry-After": "60"])]
        store.answer("d_one", choice: "Merge", text: nil)
        try await until { store.notice != nil }
        XCTAssertEqual(store.notice, "Merge isn't sent yet. Retrying.")
        XCTAssertEqual(store.saved.outbox.map(\.decisionId), ["d_one"])
        XCTAssertEqual(HistoryText.how(try XCTUnwrap(store.decision("d_one")), store), "You: Merge · not sent yet")

        // Nothing is posted during the hold: a post would fail at once.
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(AnswerServer.posted, 1)
        XCTAssertNotNil(store.answerRetry)

        // The hold nearly over: the answer goes with no pull, and History says so.
        Api.limitedUntil.withLock { $0 = Date().addingTimeInterval(0.3) }
        try await until(10) { store.saved.outbox.isEmpty }
        XCTAssertTrue(store.saved.outbox.isEmpty)
        XCTAssertEqual(AnswerServer.posted, 2)
        XCTAssertEqual(store.decision("d_one")?.answer, "Merge")
        XCTAssertEqual(HistoryText.how(try XCTUnwrap(store.decision("d_one")), store), "You: Merge")
    }

    func testASyncSendsTheOutboxBeforeReadsThatFail() async throws {
        let store = try await store()
        AnswerServer.posts = [nil]
        store.answer("d_one", choice: "Wait", text: nil)
        try await until { store.notice != nil }
        XCTAssertEqual(store.notice, "No connection. Wait will be sent when the iPhone is back online.")
        // Only the sync this time.
        store.answerRetry?.cancel()
        try await until { store.answerRetry == nil }

        store.notice = nil
        await store.refresh()
        XCTAssertTrue(store.saved.outbox.isEmpty)
        XCTAssertEqual(store.decision("d_one")?.answer, "Wait")
        XCTAssertEqual(AnswerServer.posted, 2)
        // The reads after it failed, and say so.
        XCTAssertNotNil(store.notice)
    }
}

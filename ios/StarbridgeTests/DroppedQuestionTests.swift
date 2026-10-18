import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * A server whose open list holds `open`: the directory reads empty, `GET /items?…&open=1` lists
 * `open` and counts the read, every other list is empty, and every other call fails.
 */
final class OpenListServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var open: [SealedItem] = []
    nonisolated(unsafe) static var openReads = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let path = url.path()
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        var status = 500
        var body = #"{"error":"internal"}"#
        if path.hasSuffix("/v1/directory") {
            status = 200
            body = #"{"entries":[]}"#
        } else if request.httpMethod == "GET" && path.hasSuffix("/v1/items") {
            status = 200
            if query.contains(URLQueryItem(name: "open", value: "1")) {
                OpenListServer.openReads += 1
                let items = OpenListServer.open.enumerated().map { i, item in
                    JSON.object(["item": item.json, "cursor": .string("\(i + 1)"), "receivedAt": "2026-09-01T12:00:00Z"])
                }
                body = JSON.object(["items": .array(items), "cursor": .string("\(items.count)")]).text
            } else {
                body = #"{"items":[],"cursor":""}"#
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/** An open question kept here that the server dropped, by its retention, leaves the inbox (#1980). */
@MainActor
final class DroppedQuestionTests: XCTestCase {
    func testAnOpenQuestionTheServerDroppedLeavesTheInbox() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let f = try NotifyFixture()
        func body(_ id: String) -> JSON {
            [
                "v": 1, "id": .string(id), "to": [.string(f.phone.id)], "createdAt": "2026-09-01T12:00:00Z", "question": "Merge the inbox PR?",
                "context": "", "options": ["Merge", "Wait"], "recommended": "Wait", "source": NotifyFixture.source,
            ]
        }
        OpenListServer.open = [try f.decision("d_still")]
        OpenListServer.openReads = 0
        var saved = f.saved
        var answered = try SavedDecision(from: f.machine.id, text: body("d_answered").text, answeredAt: "2026-09-01T12:00:00Z")
        answered.answer = "Merge"
        saved.decisions = [
            try SavedDecision(from: f.machine.id, text: body("d_gone").text, answeredAt: nil),
            try SavedDecision(from: f.machine.id, text: body("d_still").text, answeredAt: nil),
            answered,
        ]
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let vault = MemoryVault()
        vault.secrets = f.secrets
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OpenListServer.self]
        let store = Store(vault: vault, disk: disk, deviceName: "Test iPhone", http: URLSession(configuration: config))
        try await store.serial { try await store.syncDirectory() }

        try await store.serial { try await store.syncDecisions() }
        // Gone from the inbox; an answered one stays in History.
        XCTAssertEqual(Set(store.saved.decisions.map(\.id)), ["d_still", "d_answered"])
        // Once a run: the next sync reads no open list.
        try await store.serial { try await store.syncDecisions() }
        XCTAssertEqual(OpenListServer.openReads, 1)
    }
}

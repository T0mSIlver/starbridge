import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** A typed reply is kept until its answer is queued, and capped as the Answer schema caps it (#1169). */
@MainActor
final class ReplyTests: XCTestCase {
    func testCappedCutsAtCodePoints() {
        let short = "ok"
        XCTAssertEqual(Store.capped(short), short)
        let long = String(repeating: "a", count: 3999) + "👍🏽"
        XCTAssertEqual(Store.capped(long).unicodeScalars.count, Store.replyLimit)
        XCTAssertEqual(Store.capped(long), String(repeating: "a", count: 3999) + "👍")
    }

    /** An answer that could not be signed comes back with its draft, to send again. */
    func testAReplyNotSentKeepsItsDraft() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let body: JSON = [
            "v": 1, "id": "d_1", "to": ["p_1"], "createdAt": "2026-10-11T08:00:00.000Z", "question": "Ship it?",
            "context": "", "options": [], "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
        ]
        var saved = Saved(server: Store.defaultServer)
        saved.decisions = [try SavedDecision(from: "m_gone", text: body.text, answeredAt: nil)]
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let store = Store(vault: MemoryVault(), disk: disk, deviceName: "Test iPhone")
        store.drafts["d_1"] = "Not yet"
        store.answer("d_1", choice: nil, text: "Not yet")
        for _ in 0..<50 where store.notSent["d_1"] == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertNotNil(store.notSent["d_1"])
        XCTAssertEqual(store.drafts["d_1"], "Not yet")
    }
}

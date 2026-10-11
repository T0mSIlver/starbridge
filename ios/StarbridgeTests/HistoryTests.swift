import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** What History says of a question that closed (spec/clients.md, "History"). */
@MainActor
final class HistoryTests: XCTestCase {
    private func settledElsewhere(_ extra: JSONObject) throws -> SavedDecision {
        var body: JSONObject = [
            "v": 1, "id": "d_1", "to": ["p_1"], "createdAt": "2026-10-11T08:00:00.000Z", "question": "Ship it?",
            "context": "", "options": [], "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
        ]
        for (k, v) in extra { body[k] = v }
        var d = try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: "2026-10-11T08:01:00.000Z")
        d.settled = "elsewhere"
        return d
    }

    /** "At the keyboard" is for a question with no page: one with a page was answered there (#865, #1157). */
    func testElsewhereReadsAtTheKeyboardOnlyWithoutAPage() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        XCTAssertEqual(HistoryText.how(try settledElsewhere([:]), store), "Answered at the keyboard")
        let paged = try settledElsewhere(["answerIn": ["url": "https://example.test/review", "title": "the review page"]])
        XCTAssertEqual(HistoryText.how(paged, store), "Answered in the review page")
    }
}

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
        XCTAssertEqual(HistoryText.how(try settledElsewhere([:]), store), "Answered · at the keyboard")
        let paged = try settledElsewhere(["answerIn": ["url": "https://example.test/review", "title": "the review page"]])
        // Another host than GitHub or a Claude artifact reads as itself, never the agent's title (#2203).
        XCTAssertEqual(HistoryText.how(paged, store), "Answered in example.test/review · by the agent")
    }

    /** A question asked long ago and answered now comes first, after one still sending, as on the web and Android (#2307). */
    func testHistoryListsTheLatestAnswerFirst() throws {
        func question(_ id: String, asked: String, answered: String?) throws -> SavedDecision {
            let body: JSONObject = [
                "v": 1, "id": .string(id), "to": ["p_1"], "createdAt": .string(asked), "question": "Ship it?",
                "context": "", "options": [], "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
            ]
            return try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: answered)
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        var saved = Saved(server: "https://example.test")
        // Kept in the order they were asked.
        saved.decisions = [
            try question("d_old", asked: "2026-10-01T08:00:00.000Z", answered: "2026-10-13T09:00:00.000Z"),
            try question("d_queued", asked: "2026-10-02T08:00:00.000Z", answered: nil),
            try question("d_new", asked: "2026-10-12T08:00:00.000Z", answered: "2026-10-12T08:05:00.000Z"),
        ]
        saved.outbox = [QueuedAnswer(decisionId: "d_queued", answer: "yes", item: "{}", at: "2026-10-13T09:30:00.000Z")]
        store.persist(saved)
        XCTAssertEqual(store.history.map(\.id), ["d_queued", "d_old", "d_new"])
    }
}

import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** The app icon's badge counts what needs the owner, as the Mac's Dock does (#1603). */
@MainActor
final class BadgeTests: XCTestCase {
    private func question(_ id: String) throws -> SavedDecision {
        let body: JSONObject = [
            "v": 1, "id": .string(id), "to": ["p_1"], "createdAt": "2026-10-13T08:00:00.000Z", "question": "Ship it?",
            "context": "", "options": [], "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
        ]
        return try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: nil)
    }

    private func prompt(_ id: String, expires: Date) throws -> SavedPrompt {
        let body: JSONObject = [
            "v": 1, "id": .string(id), "to": ["p_1"], "createdAt": .string(Dates.format(expires.addingTimeInterval(-300))), "agent": "claude-code", "tool": "Bash",
            "summary": "git push", "input": "{}", "inputHash": .string(String(repeating: "A", count: 43)), "suggestions": [],
            "expiresAt": .string(Dates.format(expires)), "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
        ]
        return try SavedPrompt(from: "m_1", text: JSON.object(body).text, answeredAt: nil)
    }

    /** An open question, one snoozed, one answered, one queued from here, a waiting prompt and an expired one. */
    private func inbox() throws -> Saved {
        var saved = Saved(server: "https://example.test")
        var snoozed = try question("d_snoozed")
        snoozed.snoozedUntil = Dates.format(Date().addingTimeInterval(3600))
        var answered = try question("d_answered")
        answered.answeredAt = "2026-10-13T08:01:00.000Z"
        saved.decisions = [try question("d_open"), snoozed, answered, try question("d_queued")]
        saved.outbox = [QueuedAnswer(decisionId: "d_queued", answer: "yes", item: "{}", at: "2026-10-13T08:02:00.000Z")]
        saved.prompts = [try prompt("perm_open", expires: Date().addingTimeInterval(600)), try prompt("perm_gone", expires: Date().addingTimeInterval(-60))]
        return saved
    }

    func testTheAppCountsOpenQuestionsAndPrompts() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        store.persist(try inbox())
        XCTAssertEqual(store.needYou, 2)
    }

    /** While the app is closed, a notification counts its own item once, and a quiet one adds none. */
    func testANotificationCountsItsItem() throws {
        let saved = try inbox()
        let new = Shown(title: "", subtitle: "", body: "", item: "d_new", category: "d.d_new")
        XCTAssertEqual(Notify.badge(new, saved: saved), 3)
        var back = new
        back.item = "d_snoozed"
        XCTAssertEqual(Notify.badge(back, saved: saved), 3)
        back.quiet = true
        XCTAssertEqual(Notify.badge(back, saved: saved), 2)
        var again = new
        again.item = "d_open"
        XCTAssertEqual(Notify.badge(again, saved: saved), 2)
    }
}

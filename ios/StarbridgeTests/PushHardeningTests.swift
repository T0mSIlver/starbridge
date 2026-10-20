import StarbridgeProtocol
import UserNotifications
import XCTest
@testable import Starbridge

/** What a push may claim before the app acts on it (internal audit 2026-10-14). */
final class PushHardeningTests: XCTestCase {
    private func userInfo(_ p: [String: Any]) -> [AnyHashable: Any] { ["p": p] }

    func testAnIdOrKindThatIsNotPlainWordsIsRefused() {
        XCTAssertNotNil(Notify.payload(userInfo(["kind": "decision", "id": "d_Ab-1", "re": "d_2"])))
        XCTAssertNotNil(Notify.payload(userInfo(["kind": "waiting", "id": "w_1", "re": NSNull()])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "decision", "id": "d_1/../directory"])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "decision", "id": "d 1"])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "decision", "id": String(repeating: "a", count: 65)])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "waiting", "id": "w_1", "re": "d_1?x=1"])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "x/y", "id": "d_1"])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "Decision", "id": "d_1"])))
        XCTAssertNil(Notify.payload(userInfo(["kind": "decision", "id": 7])))
    }

    func testAButtonNeedsItsOwnQuestionsCategory() {
        XCTAssertTrue(Notify.accepts("o:Merge", category: "d.d_1", item: "d_1"))
        XCTAssertTrue(Notify.accepts("reply", category: "d.d_1", item: "d_1"))
        XCTAssertTrue(Notify.accepts("page", category: "d.d_1", item: "d_1"))
        // A server that put another question's category on this one's notification.
        XCTAssertFalse(Notify.accepts("o:Merge", category: "d.d_2", item: "d_1"))
        XCTAssertFalse(Notify.accepts("o:Merge", category: "", item: "d_1"))
        XCTAssertFalse(Notify.accepts("o:Merge", category: "permission", item: "d_1"))
        XCTAssertTrue(Notify.accepts("deny", category: "permission", item: "p_1"))
        XCTAssertFalse(Notify.accepts("deny", category: "d.p_1", item: "p_1"))
        // A tap, and Allow, only open the item.
        XCTAssertTrue(Notify.accepts(UNNotificationDefaultActionIdentifier, category: "", item: "d_1"))
        XCTAssertTrue(Notify.accepts("allow", category: "permission", item: "p_1"))
    }

    func testTheUnreadPlaceholderKeepsNoBadge() {
        let placeholder = UNMutableNotificationContent()
        placeholder.categoryIdentifier = "d.d_1"
        placeholder.badge = 5
        Notify.unread(placeholder)
        XCTAssertNil(placeholder.badge)
        XCTAssertEqual(placeholder.categoryIdentifier, "")
    }

    func testAReplayedAnswerKeepsNoButtons() async throws {
        var f = try NotifyFixture()
        let item = try f.decision("d_one", replies: true)
        let made = await Notify.shown(f.payload(item), saved: f.saved, secrets: f.secrets) { _ in nil }
        let shown = try XCTUnwrap(made)
        XCTAssertFalse(shown.actions.isEmpty)
        let body: JSON = ["v": 1, "id": "d_one", "to": [.string(f.phone.id)], "createdAt": .string(Dates.format(Date())), "question": "Merge the inbox PR?", "context": "", "options": [], "source": NotifyFixture.source]
        // Still open here: the buttons stay.
        f.saved.decisions = [try SavedDecision(from: f.machine.id, text: body.text, answeredAt: nil)]
        XCTAssertEqual(Notify.closed(shown, saved: f.saved), shown)
        // Answered since, from anywhere: the same push shows its words, quietly, with no button.
        f.saved.decisions = [try SavedDecision(from: f.machine.id, text: body.text, answeredAt: Dates.format(Date()))]
        let replay = Notify.closed(shown, saved: f.saved)
        XCTAssertEqual(replay.title, shown.title)
        XCTAssertTrue(replay.actions.isEmpty)
        XCTAssertEqual(replay.category, "")
        XCTAssertTrue(replay.quiet)
        // And it adds nothing to the app icon's count.
        XCTAssertEqual(replay.counts, false)
        XCTAssertEqual(Notify.badge(replay, saved: f.saved), 0)
        // A question this iPhone never saved is new: it keeps its buttons.
        f.saved.decisions = []
        XCTAssertEqual(Notify.closed(shown, saved: f.saved), shown)
    }

    func testTheImagesFolderStaysOutOfBackups() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("images-\(UUID().uuidString)")
        let before = SavedImage.directory
        defer { SavedImage.directory = before; try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        SavedImage.directory = folder
        XCTAssertNotEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        SavedImage.excludeFromBackup()
        XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }
}

import CryptoKit
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

    private let key = SymmetricKey(size: .bits256)

    /** What the extension makes of question `id`: its words, category and seal. */
    private func built(_ id: String, title: String = "Run the migration on prod?", body: String = "", key: SymmetricKey? = nil) -> Delivered {
        var shown = Shown(title: title, subtitle: "devbox · app", body: body, item: id, category: Notify.category(id))
        shown.seal = Notify.seal(shown, key: key ?? self.key)
        return Delivered(title: shown.title, subtitle: shown.subtitle, body: shown.body, category: shown.category, seal: shown.seal)
    }

    func testAButtonNeedsItsOwnQuestionsCategory() {
        XCTAssertTrue(Notify.accepts("o:Merge", built("d_1"), item: "d_1", key: key))
        XCTAssertTrue(Notify.accepts("reply", built("d_1"), item: "d_1", key: key))
        XCTAssertTrue(Notify.accepts("page", built("d_1"), item: "d_1", key: key))
        // A server that put another question's category on this one's notification.
        var other = built("d_1")
        for category in ["d.d_2", "", "permission"] {
            other.category = category
            XCTAssertFalse(Notify.accepts("o:Merge", other, item: "d_1", key: key))
        }
        XCTAssertFalse(Notify.accepts("o:Merge", built("d_2"), item: "d_1", key: key))
        let prompt = Delivered(title: "Bash", subtitle: "", body: "ls", category: "permission", seal: nil)
        XCTAssertTrue(Notify.accepts("deny", prompt, item: "p_1", key: key))
        var asQuestion = prompt
        asQuestion.category = "d.p_1"
        XCTAssertFalse(Notify.accepts("deny", asQuestion, item: "p_1", key: key))
        // A tap, and Allow, only open the item.
        XCTAssertTrue(Notify.accepts(UNNotificationDefaultActionIdentifier, Delivered(title: "", subtitle: "", body: "", category: "", seal: nil), item: "d_1", key: nil))
        XCTAssertTrue(Notify.accepts("allow", prompt, item: "p_1", key: key))
    }

    /**
     * A server sends an alert the extension never rewrites, with question d_1's category under
     * words of its own: its buttons answer nothing, whatever seal it copies or makes.
     */
    func testAServerWrittenNotificationAnswersNothing() {
        let real = built("d_1")
        var forged = real
        forged.title = "Run the migration on staging?"
        for seal in [nil, real.seal, "", "AAAA", built("d_1", title: forged.title, key: SymmetricKey(size: .bits256)).seal] {
            forged.seal = seal
            for action in ["o:Yes", "reply", "page"] {
                XCTAssertFalse(Notify.accepts(action, forged, item: "d_1", key: key), "\(action) with seal \(seal ?? "none")")
            }
        }
        // Every word the notification shows is covered, and the item it answers.
        var body = real
        body.body = "staging"
        XCTAssertFalse(Notify.accepts("o:Yes", body, item: "d_1", key: key))
        var subtitle = real
        subtitle.subtitle = "laptop · app"
        XCTAssertFalse(Notify.accepts("o:Yes", subtitle, item: "d_1", key: key))
        XCTAssertFalse(Notify.accepts("o:Yes", built("d_1", key: SymmetricKey(size: .bits256)), item: "d_1", key: key))
        // Without this iPhone's keys (signed out), no button answers.
        XCTAssertFalse(Notify.accepts("o:Yes", real, item: "d_1", key: nil))
    }

    func testTheSealingKeyComesFromThisIPhonesBoxKey() throws {
        let f = try NotifyFixture()
        let key = try XCTUnwrap(Notify.sealingKey(f.secrets))
        let again = try XCTUnwrap(Notify.sealingKey(f.secrets))
        XCTAssertTrue(Notify.accepts("o:Yes", built("d_1", key: key), item: "d_1", key: again))
        XCTAssertNil(Notify.sealingKey(Secrets()))
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

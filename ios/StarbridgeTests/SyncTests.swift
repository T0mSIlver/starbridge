import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** Which notifications a sync closes (#1184). */
@MainActor
final class SyncTests: XCTestCase {
    /** A snooze about to end keeps its notification: the "Back from snooze" may be up already, by a server clock ahead. */
    func testASnoozeAboutToWakeKeepsItsNotification() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        func question(_ id: String, snoozedFor seconds: TimeInterval) throws -> SavedDecision {
            let body: JSON = [
                "v": 1, "id": .string(id), "to": ["p_1"], "createdAt": "2026-10-11T08:00:00.000Z", "question": "Ship it?",
                "context": "", "options": [], "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
            ]
            var d = try SavedDecision(from: "m_1", text: body.text, answeredAt: nil)
            d.snoozedUntil = Dates.format(Date().addingTimeInterval(seconds))
            d.snoozedAt = Dates.format(Date())
            return d
        }
        var saved = Saved(server: Store.defaultServer)
        saved.decisions = [try question("d_waking", snoozedFor: 60), try question("d_later", snoozedFor: 3600)]
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let store = Store(vault: MemoryVault(), disk: disk, deviceName: "Test iPhone")
        XCTAssertEqual(store.closedItems, ["d_later"])
    }

    /**
     * Heads this app kept before #1627: a head a machine before #794 passed on, under
     * "signer/by" or "signer/?" and naming `by`. Each loads under its key, which HeadBook reads as
     * its signer's, and goes with that signer.
     */
    func testHeadsKeptUnderTheSlotsOfMachinesBefore794Load() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let a = String(repeating: "A", count: 43)
        func head(_ length: Int, by: String? = nil) -> String {
            #"{"length":\#(length),"head":"\#(a)""# + (by.map { #","by":"\#($0)""# } ?? "") + "}"
        }
        var saved = Saved(server: Store.defaultServer)
        saved.heads = [
            SavedHead(id: "devbox", head: head(4)),
            SavedHead(id: "devbox/phone", head: head(5, by: "phone")),
            SavedHead(id: "devbox/?", head: head(6, by: "ghost")),
        ]
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        var heads = Heads(saved: try XCTUnwrap(disk.load()).heads)
        XCTAssertEqual(heads.keys, ["devbox", "devbox/phone", "devbox/?"])
        XCTAssertEqual(heads["devbox/phone"], DirectoryHead(length: 5, head: a, by: "phone"))
        XCTAssertTrue(HeadBook.forget(&heads, id: "devbox"))
        XCTAssertTrue(heads.isEmpty)
    }
}

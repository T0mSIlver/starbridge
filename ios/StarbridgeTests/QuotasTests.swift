import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** The Quotas tab: windows from snapshots, their order, bars and words (spec/items.md, "Quotas"). */
@MainActor
final class QuotasTests: XCTestCase {
    private let now = Dates.parse("2026-10-14T12:00:00.000Z")!

    private func at(_ hours: Double) -> String { Dates.format(now.addingTimeInterval(hours * 3600)) }

    private func window(_ id: String, label: String = "", used: Double, minutes: Int? = 300, resetsIn hours: Double? = 3, pace: JSON = .null) -> JSON {
        ["id": .string(id), "label": .string(label), "usedPercent": .number(used), "windowMinutes": minutes.map { .number(Double($0)) } ?? .null,
         "resetsAt": hours.map { .string(at($0)) } ?? .null, "pace": pace]
    }

    private func pace(_ stage: String, expected: Double, lasts: Bool, runsOutIn: Double? = nil) -> JSON {
        ["stage": .string(stage), "expectedUsedPercent": .number(expected), "deltaPercent": 0, "projectedUsedPercent": .number(expected),
         "willLastToReset": .bool(lasts), "runsOutAt": runsOutIn.map { .string(at($0)) } ?? .null]
    }

    private func snapshot(_ providers: [JSON], alerts: [JSON] = []) throws -> SavedQuota {
        let body: JSON = ["v": 1, "id": "q_1", "to": ["p_1"], "takenAt": .string(at(-0.1)), "providers": .array(providers), "alerts": .array(alerts)]
        return try SavedQuota(from: "m_1", text: body.text)
    }

    private func store(_ quotas: [SavedQuota]) throws -> Store {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        var saved = Saved(server: Store.defaultServer)
        saved.quotas = quotas
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        return Store(vault: MemoryVault(), disk: disk, deviceName: "Test iPhone")
    }

    private func row(_ provider: String, _ id: String, pace: QuotaPace = .even, used: Int = 40, resetsIn: Double? = 3, minutes: Int? = 300, steady: Int? = nil) -> QuotaRow {
        QuotaRow(id: "m_1/\(provider)/\(id)", provider: provider, window: id, windowId: id, usedPercent: used, resetsAt: resetsIn.map { now.addingTimeInterval($0 * 3600) },
                 pace: pace, steadyPercent: steady, machine: nil, windowMinutes: minutes, takenAt: now, error: nil)
    }

    func testWindowsAndFailuresComeFromTheSavedSnapshot() throws {
        let q = try snapshot([
            ["provider": "claude", "windows": [
                window("primary", label: "5-hour", used: 80, pace: pace("ahead", expected: 50, lasts: false, runsOutIn: 1)),
                window("secondary", used: 20, minutes: 10080, resetsIn: 2, pace: pace("behind", expected: 70, lasts: true)),
            ]],
            ["provider": "cursor", "windows": [], "error": "CodexBar timed out"],
        ], alerts: [["kind": "unused-headroom", "unusedPercent": 64.6, "provider": "claude", "window": "secondary", "resetsAt": .string(at(2))]])
        let s = try store([q])
        // Kept across a relaunch, as the file holds it.
        XCTAssertEqual(s.saved.quotas, [q])
        let w = s.quotaWindows
        XCTAssertEqual(w.map(\.window), ["5-hour", "secondary"])
        XCTAssertEqual(w[0].pace, .runsOut(now.addingTimeInterval(3600)))
        XCTAssertEqual(w[0].steadyPercent, 50)
        XCTAssertEqual(w[1].pace, .unused(65))
        XCTAssertEqual(s.quotaFailures, [QuotaFailure(provider: "cursor", error: "CodexBar timed out", machine: nil)])
        XCTAssertTrue(s.quotasHeld)
        XCTAssertFalse(try store([]).quotasHeld)
    }

    func testOrderHiddenAndRunningOutFirst() {
        let windows = [row("claude", "a"), row("codex", "a"), row("claude", "b", pace: .runsOut(now.addingTimeInterval(3600))), row("zai", "a")]
        var s = QuotaSettings()
        s.order = ["codex"]
        s.hidden = ["zai"]
        XCTAssertEqual(s.providers(windows), ["codex", "claude", "zai"])
        // A provider with a window running out leads, its other windows after it.
        XCTAssertEqual(s.arrange(windows, now).map(\.id), ["m_1/claude/b", "m_1/codex/a", "m_1/claude/a"])
        XCTAssertEqual(s.groups(s.arrange(windows, now)).map { $0.map(\.id) }, [["m_1/claude/b", "m_1/claude/a"], ["m_1/codex/a"]])
        s.runningOutFirst = false
        XCTAssertEqual(s.arrange(windows, now).map(\.id), ["m_1/codex/a", "m_1/claude/a", "m_1/claude/b"])
    }

    func testABarShowsUsedOrLeftOnOneScale() {
        var s = QuotaSettings()
        XCTAssertEqual(s.bar(row("claude", "a", used: 30, steady: 45), now), .init(percent: 30, word: "used", steady: 45, ticks: []))
        s.showUsed = false
        XCTAssertEqual(s.bar(row("claude", "a", used: 30, steady: 45), now), .init(percent: 70, word: "left", steady: 55, ticks: []))
    }

    func testWorkdayTicksAndPaceOnWeeklyBars() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris")!
        // A week from Monday 00:00 to the next, read on Wednesday 00:00: two of five workdays passed.
        let monday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 19))!
        let wednesday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 14))!
        let w = QuotaRow(id: "w", provider: "claude", window: "Weekly", windowId: "w", usedPercent: 10, resetsAt: monday, pace: .even,
                         steadyPercent: 29, machine: nil, windowMinutes: QuotaSettings.week, takenAt: nil, error: nil)
        var s = QuotaSettings()
        XCTAssertEqual(s.bar(w, wednesday, calendar).steady, 29)
        s.workDays = 5
        XCTAssertEqual(s.ticks(w), [0.2, 0.4, 0.6, 0.8])
        XCTAssertEqual(s.bar(w, wednesday, calendar).steady, 40)
        XCTAssertEqual(s.ticks(row("claude", "a")), [])
    }

    func testTheWindowsStateInWords() {
        let words = { (r: QuotaRow) in QuotaState.of(r, self.now, absolute: false).1 }
        XCTAssertEqual(words(row("c", "a")), "On pace")
        XCTAssertEqual(words(row("c", "a", pace: .runsOut(now.addingTimeInterval(2 * 3600)))), "Will run out in 2 h")
        XCTAssertEqual(words(row("c", "a", pace: .unused(40))), "Headroom unused")
        XCTAssertEqual(words(row("c", "a", pace: .unknown)), "Too early to tell")
        XCTAssertEqual(words(row("c", "a", resetsIn: -0.5)), "Window reset")
        XCTAssertEqual(row("c", "a", pace: .runsOut(now.addingTimeInterval(-60))).course(now), .ranOut)
        XCTAssertEqual(QuotaState.reset(row("c", "a"), now, absolute: false), "Resets in 3 h")
        XCTAssertEqual(QuotaState.reset(row("c", "a", resetsIn: -0.5), now, absolute: false), "Reset 30 min ago")
        XCTAssertEqual(QuotaState.reset(row("c", "a", resetsIn: nil), now, absolute: false), "Reset time unknown")
        XCTAssertEqual(machineList(["devbox", "laptop", "pi"]), "devbox, laptop and pi")
    }

    func testSettingsKeepUnknownFieldsDefaulted() throws {
        let s = try JSONDecoder().decode(QuotaSettings.self, from: Data(#"{"showUsed":false}"#.utf8))
        XCTAssertFalse(s.showUsed)
        XCTAssertTrue(s.runningOutFirst)
    }
}

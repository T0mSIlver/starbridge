import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** Quota alerts per window (spec/items.md, "Quota alerts per window"). */
final class QuotaAlertsTests: XCTestCase {
    func testDefaultsFollowTheWindowsLength() {
        let a = QuotaAlerts()
        XCTAssertEqual(a.choices(provider: "claude", window: "primary", minutes: 300), [])
        XCTAssertEqual(a.choices(provider: "claude", window: "secondary", minutes: 10080), ["runs-out"])
        XCTAssertEqual(a.choices(provider: "zai", window: "x", minutes: nil), ["runs-out"])
    }

    func testATickedBoxIsTheWindowsOwnAndAnEmptyRowIsOff() {
        let all = [("claude", "primary"), ("claude", "secondary")]
        var a = QuotaAlerts().with(provider: "claude", window: "primary", all: all, picked: ["low-20"])
        XCTAssertEqual(a.choices(provider: "claude", window: "primary", minutes: 300), ["low-20"])
        XCTAssertEqual(a.choices(provider: "claude", window: "secondary", minutes: 10080), ["runs-out"])
        a = a.with(provider: "claude", window: "secondary", all: all, picked: [])
        XCTAssertFalse(a.wants(provider: "claude", window: "secondary", kind: "runs-out", threshold: nil, minutes: 10080))
        // Only the lowest level reached is raised: picking 50% still notifies at 20%.
        a = a.with(provider: "claude", window: "primary", all: all, picked: ["low-50"])
        XCTAssertTrue(a.wants(provider: "claude", window: "primary", kind: "low", threshold: 20, minutes: 300))
    }

    func testAProvidersKeySplitsIntoItsWindowsOnTheFirstChange() {
        var a = QuotaAlerts()
        a.windows = ["claude": ["runs-out", "low-50"]]
        a = a.with(provider: "claude", window: "primary", all: [("claude", "primary"), ("claude", "secondary")], picked: [])
        XCTAssertEqual(a.windows, ["claude/primary": [], "claude/secondary": ["runs-out", "low-50"]])
    }

    func testNoticesSayWhatTheUploaderRaised() throws {
        let now = Dates.parse("2026-10-14T12:00:00.000Z")!
        let at = { (h: Double) in Dates.format(now.addingTimeInterval(h * 3600)) }
        let body: JSON = [
            "v": 1, "id": "q_7", "to": ["p_1"], "takenAt": .string(at(0)),
            "providers": [["provider": "claude", "windows": [["id": "secondary", "label": "Weekly", "usedPercent": 81, "windowMinutes": 10080, "resetsAt": .string(at(50)), "pace": .null]]]],
            "alerts": [
                ["kind": "low", "threshold": 20, "provider": "claude", "window": "secondary", "resetsAt": .string(at(50)), "notify": true],
                ["kind": "runs-out", "runsOutAt": .string(at(5)), "provider": "claude", "window": "secondary", "resetsAt": .string(at(50)), "notify": true],
                ["kind": "unused-headroom", "unusedPercent": 30.4, "provider": "claude", "window": "secondary", "resetsAt": .string(at(50))],
            ],
        ]
        let n = QuotaNotice.of(try SavedQuota(from: "m_1", text: body.text), now: now)
        XCTAssertEqual(n.map(\.title), ["claude Weekly: 20% left", "claude Weekly will run out"])
        XCTAssertEqual(n.map(\.text), ["Resets in 2 d 2 h.", "Runs out in 5 h at this pace; resets in 2 d 2 h."])
        XCTAssertEqual(n.map(\.key), ["q_7/claude/secondary/low", "q_7/claude/secondary/runs-out"])
        XCTAssertEqual(n[0].threshold, 20)
        XCTAssertEqual(n[0].minutes, 10080)
    }

    func testANoticeShowsOnce() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        XCTAssertTrue(QuotaShown.first("q_1/claude/secondary/low", defaults))
        XCTAssertFalse(QuotaShown.first("q_1/claude/secondary/low", defaults))
        XCTAssertTrue(QuotaShown.first("q_2/claude/secondary/low", defaults))
    }
}

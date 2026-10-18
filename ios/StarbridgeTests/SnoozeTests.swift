import XCTest
@testable import Starbridge

/** The times Snooze offers (spec/clients.md, "Snoozed"). */
final class SnoozeTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Paris")!
        return c
    }()

    private func at(_ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute, second: second))!
    }

    /** The clock is rarely on a whole minute: 16:30:20 offers 17:30, not 17:31 (#1951). */
    func testTodayStartsOnTheHalfHourWhateverTheSeconds() {
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 16, 30, 20), calendar), at(11, 17, 30))
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 16, 0, 20), calendar), at(11, 17, 0))
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 16, 29, 59), calendar), at(11, 17, 30))
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 16, 31, 5), calendar), at(11, 18, 0))
    }

    func testThisEveningIsOfferedUntilFive() {
        XCTAssertEqual(SnoozeTimes.presets(at(11, 16, 59), calendar).map(\.0), ["1 hour", "This evening"])
        XCTAssertEqual(SnoozeTimes.presets(at(11, 16, 59), calendar).last?.1, at(11, 18, 0))
        XCTAssertEqual(SnoozeTimes.presets(at(11, 17, 0), calendar).map(\.0), ["1 hour"])
    }

    func testTodayStartsAnHourAheadUpToTheHalfHourOtherDaysAtNine() {
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 14, 10), calendar), at(11, 15, 30))
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 14, 40), calendar), at(11, 16, 0))
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 14, 0), calendar), at(11, 15, 0))
        XCTAssertEqual(SnoozeTimes.start(at(13, 0, 0), at(11, 14, 10), calendar), at(13, 9, 0))
        // Late in the evening, today's last half hour rather than tomorrow.
        XCTAssertEqual(SnoozeTimes.start(at(11, 0, 0), at(11, 22, 35), calendar), at(11, 23, 30))
        XCTAssertEqual(SnoozeTimes.days(at(11, 14, 0), calendar).count, 8)
    }

    func testASnoozeRunsFiveMinutesToSevenDays() {
        let now = at(11, 14, 0)
        XCTAssertFalse(SnoozeTimes.allowed(now.addingTimeInterval(4 * 60), now))
        XCTAssertTrue(SnoozeTimes.allowed(now.addingTimeInterval(5 * 60), now))
        XCTAssertTrue(SnoozeTimes.allowed(now.addingTimeInterval(7 * 86_400), now))
        XCTAssertFalse(SnoozeTimes.allowed(now.addingTimeInterval(7 * 86_400 + 60), now))
    }

    func testASwipeSnoozesForTheTimeSetOrAsks() {
        XCTAssertEqual(SwipeSnooze.hour.until(at(11, 14, 0), calendar), at(11, 15, 0))
        XCTAssertEqual(SwipeSnooze.threeHours.until(at(11, 14, 0), calendar), at(11, 17, 0))
        XCTAssertEqual(SwipeSnooze.morning.until(at(11, 14, 0), calendar), at(12, 9, 0))
        // At 1:00 the owner means this morning.
        XCTAssertEqual(SwipeSnooze.morning.until(at(12, 1, 0), calendar), at(12, 9, 0))
        XCTAssertNil(SwipeSnooze.ask.until(at(11, 14, 0), calendar))
    }

    /** Back now within the second of a snooze goes a second later, and at its own time (#1991). */
    func testBackNowRightAfterASnoozeCarriesALaterTime() {
        let now = Date(timeIntervalSince1970: 1_792_317_600.4)
        let snoozed = SnoozeStamps.of(until: now.addingTimeInterval(3600), last: nil, now: now)
        XCTAssertEqual(snoozed.at, "2026-10-18T10:00:00Z")
        XCTAssertEqual(snoozed.until, "2026-10-18T11:00:00Z")
        let back = SnoozeStamps.of(until: now.addingTimeInterval(0.3), last: snoozed.at, now: now.addingTimeInterval(0.3))
        XCTAssertEqual(back.at, "2026-10-18T10:00:01Z")
        // At or before its `at`, and not after now, so the server schedules no return.
        XCTAssertEqual(back.until, "2026-10-18T10:00:00Z")
        // A last snooze from the web, in milliseconds, within the same second.
        let fromWeb = SnoozeStamps.of(until: now, last: "2026-10-18T10:00:00.900Z", now: now.addingTimeInterval(0.3))
        XCTAssertEqual(fromWeb.at, "2026-10-18T10:00:01Z")
        XCTAssertEqual(fromWeb.until, "2026-10-18T10:00:00Z")
        // A second later, the clock's own second.
        let later = SnoozeStamps.of(until: now.addingTimeInterval(5), last: snoozed.at, now: now.addingTimeInterval(5))
        XCTAssertEqual(later.at, "2026-10-18T10:00:05Z")
    }
}

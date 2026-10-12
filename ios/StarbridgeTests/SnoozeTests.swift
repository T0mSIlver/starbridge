import XCTest
@testable import Starbridge

/** The times Snooze offers (spec/clients.md, "Snoozed"). */
final class SnoozeTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Paris")!
        return c
    }()

    private func at(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
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
}

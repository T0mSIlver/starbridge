import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** The Runs head counts its runs and names failed and lost ones, so closing it never hides a failure (#835, #1170). */
final class RunsTests: XCTestCase {
    private func run(_ id: String, at: Date, exit: Int? = nil) throws -> SavedRun {
        var body: JSONObject = [
            "v": 1, "id": .string(id), "to": ["p_1"], "title": "Build", "reason": "Blocks the owner",
            "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
            "startedAt": .string(Dates.format(at.addingTimeInterval(-60))), "at": .string(Dates.format(at)),
        ]
        if let exit { body["exit"] = ["code": .number(Double(exit)), "at": .string(Dates.format(at))] }
        return try SavedRun(from: "m_1", text: JSON.object(body).text)
    }

    func testTheHeadNamesFailedAndLostRuns() throws {
        let now = Date()
        let running = try run("r_1", at: now)
        let passed = try run("r_2", at: now, exit: 0)
        let failed = try run("r_3", at: now, exit: 2)
        let lost = try run("r_4", at: now.addingTimeInterval(-600))
        XCTAssertEqual(RunsHead.count([running, passed, failed, lost]), "4")
        let words = RunsHead.words([running, passed, failed, lost])
        XCTAssertEqual(words.failed, "· 1 failed")
        XCTAssertEqual(words.lost, "· 1 lost")
        let quiet = RunsHead.words([running, passed])
        XCTAssertNil(quiet.failed)
        XCTAssertNil(quiet.lost)
    }

    /** Running runs newest first, then the ended and lost ones of the last 30 minutes, latest news first, as on the web and Android (#827). */
    func testShownRunsKeepThirtyMinutesInWebOrder() throws {
        let now = Date()
        let older = try run("r_old", at: now.addingTimeInterval(-30))
        let newer = try run("r_new", at: now)
        let passed = try run("r_passed", at: now.addingTimeInterval(-120), exit: 0)
        let failed = try run("r_failed", at: now.addingTimeInterval(-60), exit: 1)
        let stale = try run("r_stale", at: now.addingTimeInterval(-31 * 60), exit: 0)
        let ids = SavedRun.shown([older, passed, stale, newer, failed], now: now).map(\.id)
        XCTAssertEqual(ids, ["r_new", "r_old", "r_failed", "r_passed"])
    }

    /** Stamps compare as instants: a whole-second one sorts after the same second's milliseconds as text (#1079). */
    func testStampsSortAsInstants() {
        let stamps = ["2026-10-14T08:00:05Z", "2026-10-14T08:00:05.001Z", "2026-10-14T08:00:04.999Z"]
        XCTAssertEqual(Dates.byInstant(stamps) { $0 }, ["2026-10-14T08:00:04.999Z", "2026-10-14T08:00:05Z", "2026-10-14T08:00:05.001Z"])
    }
}

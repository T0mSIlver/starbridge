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
}

import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** The agent's default comes first on cards, in the detail and in the notification (#191, #1185). */
final class OptionsTests: XCTestCase {
    private func decision(_ recommended: String, options: [JSON] = ["Merge", "Wait", "Close"]) throws -> Decision {
        let body: JSONObject = [
            "v": 1, "id": "d_1", "to": ["p_1"], "createdAt": "2026-10-11T08:00:00.000Z", "question": "Ship it?",
            "context": "", "options": .array(options), "source": ["machine": "devbox", "project": "starbridge", "session": "s1"], "recommended": .string(recommended),
        ]
        return try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: nil).body
    }

    func testTheRecommendedOptionComesFirst() throws {
        XCTAssertEqual(try decision("Close").ordered, ["Close", "Merge", "Wait"])
        XCTAssertEqual(try decision("Merge").ordered, ["Merge", "Wait", "Close"])
        // Options that differ only by code points stay two, as the schema counts them.
        let scalars = try decision("e\u{301}", options: ["\u{E9}", "e\u{301}"]).ordered.map { Array($0.unicodeScalars) }
        XCTAssertEqual(scalars, [Array("e\u{301}".unicodeScalars), Array("\u{E9}".unicodeScalars)])
    }
}

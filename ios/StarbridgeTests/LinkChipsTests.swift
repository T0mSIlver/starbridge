@testable import Starbridge
@testable import StarbridgeProtocol
import UIKit
import XCTest

final class LinkChipsTests: XCTestCase {
    // A missing asset only leaves its chip plain, so this test is what catches it (#1577).
    func testEveryLinkIconHasItsAsset() {
        for icon in LinkIcon.allCases {
            XCTAssertNotNil(UIImage(named: "Octicon-\(icon.rawValue)"), icon.rawValue)
        }
    }

    func testAnswerInPlaceNamesAnArtifact() throws {
        XCTAssertEqual(Notify.place(try link("https://claude.ai/artifact/abc")), "the artifact")
        XCTAssertEqual(Notify.place(try link("https://claude.ai/artifact/abc", "Mockups")), "Mockups")
        XCTAssertEqual(Notify.place(try link("https://example.com/vote")), "example.com/vote")
        // Another host's title never shows: only GitHub and a Claude artifact get the agent's words.
        XCTAssertEqual(Notify.place(try link("https://example.com/vote", "Design doc")), "example.com/vote")
    }
}

private func link(_ url: String, _ title: String? = nil) throws -> DecisionLink {
    var o: JSONObject = ["url": .string(url)]
    o.put("title", title.map(JSON.string))
    return try DecisionLink(Fields(.object(o), "links"))
}

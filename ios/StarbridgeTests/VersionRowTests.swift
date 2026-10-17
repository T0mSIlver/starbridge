import XCTest
@testable import Starbridge

/// The Version row at the end of Settings → Account (#1892).
@MainActor
final class VersionRowTests: XCTestCase {
    func testTheRowShowsTheWholeTagAndFallsBackToTheNumericVersion() {
        XCTAssertEqual(SettingsView.shown(["StarbridgeVersion": "0.1.8-rc.3", "CFBundleShortVersionString": "0.1.8"]), "0.1.8-rc.3")
        XCTAssertEqual(SettingsView.shown(["CFBundleShortVersionString": "0.1.8"]), "0.1.8")
        XCTAssertEqual(SettingsView.shown(["StarbridgeVersion": "", "CFBundleShortVersionString": "0.1.8"]), "0.1.8")
        XCTAssertEqual(SettingsView.shown(nil), "")
    }

    func testTheBuildCarriesTheVersionKeyAndTheShortVersionStaysNumeric() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)
        XCTAssertNotNil(info["StarbridgeVersion"])
        XCTAssertEqual(SettingsView.version, info["StarbridgeVersion"] as? String)
        let short = try XCTUnwrap(info["CFBundleShortVersionString"] as? String)
        XCTAssertNil(short.firstIndex(of: "-"), "Apple takes only digits and dots")
    }

    func testACopyPutsTheVersionOnThePasteboardAndReadsCopiedForAMoment() async throws {
        UIPasteboard.general.string = "before"
        let model = VersionCopy(version: "0.1.8-rc.3", hold: .milliseconds(100))
        XCTAssertFalse(model.copied)
        model.copy()
        XCTAssertEqual(UIPasteboard.general.string, "0.1.8-rc.3")
        XCTAssertTrue(model.copied)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertFalse(model.copied)
    }
}

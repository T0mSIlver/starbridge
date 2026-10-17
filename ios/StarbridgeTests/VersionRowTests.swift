import XCTest
@testable import Starbridge

/// The Version row at the end of Settings → Account (#1892).
@MainActor
final class VersionRowTests: XCTestCase {
    func testTheRowShowsTheBundlesVersion() {
        let bundled = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        XCTAssertNotNil(bundled)
        XCTAssertEqual(SettingsView.version, bundled)
        XCTAssertFalse(SettingsView.version.isEmpty)
    }
}

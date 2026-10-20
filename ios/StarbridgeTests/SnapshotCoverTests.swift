import UIKit
import XCTest
@testable import Starbridge

/** The app switcher's snapshot shows the cover, not the inbox or a question's sheet (security audit 2026-10-20, N13). */
@MainActor
final class SnapshotCoverTests: XCTestCase {
    func testTheCoverGoesUpInTheBackgroundAndDownInFront() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let center = NotificationCenter()
        let cover = SnapshotCover()
        cover.install(center)
        XCTAssertNil(cover.window(over: scene))
        center.post(name: UIScene.didEnterBackgroundNotification, object: scene)
        let window = try XCTUnwrap(cover.window(over: scene))
        XCTAssertFalse(window.isHidden)
        // Above every window the app shows, sheets and alerts included.
        XCTAssertGreaterThan(window.windowLevel, .alert)
        XCTAssertTrue(scene.windows.filter { $0 !== window }.allSatisfy { $0.windowLevel < window.windowLevel })
        // A second background notice adds no second cover.
        center.post(name: UIScene.didEnterBackgroundNotification, object: scene)
        XCTAssertTrue(cover.window(over: scene) === window)
        center.post(name: UIScene.willEnterForegroundNotification, object: scene)
        XCTAssertNil(cover.window(over: scene))
        XCTAssertTrue(window.isHidden)
    }
}

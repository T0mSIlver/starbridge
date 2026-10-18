import SwiftUI
import XCTest
@testable import Starbridge

/** Reduce Motion and Dynamic Type (#1947): nothing changes at the default settings. */
@MainActor
final class AccessibilityTests: XCTestCase {
    override func tearDown() {
        Motion.reducedForTests = nil
        super.tearDown()
    }

    func testReduceMotionTurnsEveryAnimationOff() {
        Motion.reducedForTests = true
        XCTAssertNil(Motion.animation(.smooth))
        var ran = 0
        Motion.with(.spring(duration: 0.3)) { ran += 1 }
        XCTAssertEqual(ran, 1, "the change still happens, without animating")
        Motion.reducedForTests = false
        XCTAssertNotNil(Motion.animation(.smooth))
        XCTAssertNotNil(Motion.animation())
    }

    /** The view drawn at 3x on a white page, as an image of its pixels. */
    private func pixels(_ view: some View, size: DynamicTypeSize = .large) throws -> Data {
        let renderer = ImageRenderer(content: view.environment(\.dynamicTypeSize, size).background(Color.white))
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage)
        return try XCTUnwrap(image.pngData())
    }

    func testAOneLinePillIsTheCapsuleItReplaced() throws {
        let label = Text("Ship it").frame(width: 280, height: 48)
        let capsule = try pixels(label.background(Capsule().fill(Color.orange)))
        let pill = try pixels(label.background(Pill(limit: 24).fill(Color.orange)))
        XCTAssertEqual(pill, capsule)
    }

    func testAPillThatWrapsKeepsRoomForItsText() {
        let wrapped = CGRect(x: 0, y: 0, width: 280, height: 140)
        let corner = CGPoint(x: 14, y: 14)
        XCTAssertTrue(Pill(limit: 24).path(in: wrapped).contains(corner), "text near the corner stays on the button")
        XCTAssertFalse(Capsule().path(in: wrapped).contains(corner), "a capsule's curve would cut it")
    }

    func testSymbolsKeepTheirSizeAtTheDefaultAndGrowWithDynamicType() throws {
        let fixed = Image(systemName: "laptopcomputer").font(.system(size: 14))
        let scaled = Image(systemName: "laptopcomputer").scaledFont(size: 14)
        XCTAssertEqual(try pixels(scaled), try pixels(fixed), "unchanged at the default text size")
        let big = try XCTUnwrap(UIImage(data: pixels(scaled, size: .accessibility3)))
        let normal = try XCTUnwrap(UIImage(data: pixels(scaled)))
        XCTAssertGreaterThan(big.size.height, normal.size.height)
        XCTAssertEqual(try XCTUnwrap(UIImage(data: pixels(fixed, size: .accessibility3))).size.height, normal.size.height, "the fixed one did not")
    }
}

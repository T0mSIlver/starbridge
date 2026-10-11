import UIKit
import XCTest
@testable import Starbridge

/** Images decode by their real size, within the declared one and Android's limits (#360). */
final class ImagesTests: XCTestCase {
    private func png(_ w: Int, _ h: Int) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).pngData { ctx in
            UIColor.orange.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
    }

    private func pixels(_ image: UIImage?) -> CGSize? { image?.cgImage.map { CGSize(width: $0.width, height: $0.height) } }

    func testDecodesWithinTheDeclaredSizeScaledToTheEdgeAsked() {
        let data = png(200, 100)
        XCTAssertEqual(pixels(SavedImage.decode(data, width: 200, height: 100, maxEdge: 1024)), CGSize(width: 200, height: 100))
        XCTAssertEqual(pixels(SavedImage.decode(data, width: 200, height: 100, maxEdge: 50)), CGSize(width: 50, height: 25))
    }

    func testRefusesAnImageLargerThanDeclaredOrPastTheEdgeLimit() {
        XCTAssertNil(SavedImage.decode(png(200, 100), width: 199, height: 100, maxEdge: 1024))
        XCTAssertNil(SavedImage.decode(png(200, 100), width: 200, height: 99, maxEdge: 1024))
        XCTAssertNil(SavedImage.decode(png(8193, 1), width: 8193, height: 1, maxEdge: 8192))
        XCTAssertNil(SavedImage.decode(Data("not an image".utf8), width: 10, height: 10, maxEdge: 1024))
    }

    func testHoldsAtMost4096SquaredPixels() throws {
        let size = try XCTUnwrap(pixels(SavedImage.decode(png(8000, 4000), width: 8000, height: 4000, maxEdge: SavedImage.maxEdge)))
        XCTAssertLessThanOrEqual(Int(size.width) * Int(size.height), SavedImage.maxPixels)
        XCTAssertGreaterThan(Int(size.width) * Int(size.height), SavedImage.maxPixels * 9 / 10)
    }
}

import SwiftUI
import UIKit

/**
 Reduce Motion (#1947): every animation the app starts goes through here, so it runs only while the
 system setting is off. Without an animation SwiftUI still makes the change, at once.
 */
@MainActor
enum Motion {
    /** Tests set this to stand in for the system setting. */
    static var reducedForTests: Bool?

    static var reduced: Bool { reducedForTests ?? UIAccessibility.isReduceMotionEnabled }

    /** For `.animation(_:value:)`: nil while Reduce Motion is on. */
    static func animation(_ animation: Animation = .default) -> Animation? { reduced ? nil : animation }

    /** `withAnimation`, which makes the change without animating it while Reduce Motion is on. */
    static func with<Result>(_ animation: Animation = .default, _ body: () throws -> Result) rethrows -> Result {
        try withAnimation(Self.animation(animation), body)
    }
}

/** A system-font symbol or figure that scales with Dynamic Type from `size` at the default setting. */
private struct ScaledSystemFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight, relativeTo style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight))
    }
}

extension View {
    /** `.font(.system(size:))` that follows Dynamic Type; the same size at the default setting. */
    func scaledFont(size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ScaledSystemFont(size: size, weight: weight, relativeTo: style))
    }
}

/**
 A capsule that stops rounding at `limit`: one line of text is a capsule as before, and a label that
 wraps to more lines gets a rounded rectangle, not curves its text spills past.
 */
struct Pill: Shape {
    let limit: CGFloat

    func path(in rect: CGRect) -> Path {
        RoundedRectangle(cornerRadius: min(rect.height / 2, limit), style: .continuous).path(in: rect)
    }
}

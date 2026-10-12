import SwiftUI

/**
 * The mark drawn in the theme's colours: the arch and the amber dot of design/mark.svg
 * (`MarkShape`), in a square as wide as the arch whose bottom edge is the arch's feet, as Android's
 * and the web's `Mark`. The dot is the only amber.
 */
struct Mark: View {
    let size: CGFloat

    var body: some View {
        Canvas { context, canvas in
            let k = canvas.width / MarkShape.crop.width
            context.scaleBy(x: k, y: k)
            context.translateBy(x: -MarkShape.crop.minX, y: -MarkShape.crop.minY)
            context.fill(MarkShape.arch, with: .color(Tokens.Colors.fg.color))
            context.fill(Path(ellipseIn: MarkShape.dot), with: .color(Tokens.Colors.accent.color))
        }
        .frame(width: size, height: size)
        .clipped()
        .accessibilityHidden(true)
    }
}

/** The mark and the name as one sign, with the web's gap of 0.4 of the mark between them. */
struct Lockup: View {
    var mark: CGFloat = 56

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: (mark * 0.4).rounded()) {
            Mark(size: mark).alignmentGuide(.lastTextBaseline) { $0[.bottom] }
            Text("Starbridge").type(Tokens.Typography.title).lineLimit(1).minimumScaleFactor(0.5)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starbridge")
    }
}

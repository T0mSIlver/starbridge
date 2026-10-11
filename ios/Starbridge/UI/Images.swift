import ImageIO
import SwiftUI
import UIKit

extension SavedImage {
    /** The longest edge an image may have, as the protocol bounds `width` and `height`. */
    static let maxEdge = 8192

    /** The most pixels a decode holds, 64 MB at 4 bytes each, whatever `maxEdge` a view asks. */
    static let maxPixels = 4096 * 4096

    /**
     * `data` decoded at most about `maxEdge` pixels on its longer side, so a thumbnail never holds
     * the full bitmap, as on Android (#360). Sized by the image's real size, not the declared one,
     * which a machine could understate. Nil when it does not decode, or is larger than declared.
     */
    static func decode(_ data: Data, width: Int, height: Int, maxEdge edge: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int,
              w > 0, h > 0, w <= width, h <= height, max(w, h) <= maxEdge else { return nil }
        let scale = min(1, Double(edge) / Double(max(w, h)), (Double(maxPixels) / (Double(w) * Double(h))).squareRoot())
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, Int(Double(max(w, h)) * scale)),
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }

    /** This image decoded at most about `edge` pixels on its longer side; nil as [decode] says. */
    func decoded(maxEdge edge: Int) -> UIImage? { Self.decode(bytes, width: width, height: height, maxEdge: edge) }
}

/** Which image a full-screen viewer opens on. */
struct ViewerStart: Identifiable {
    let index: Int
    var id: Int { index }
}

/**
 * A question's images, two to a row (#536): both at one height and each as wide as its shape
 * asks, together filling the row, at most `maxHeight` tall; no crop, no frame. Each carries an
 * expand badge, since nothing else tells a touch screen they open (#170).
 */
struct ImageRows: View {
    let images: [SavedImage]
    var maxHeight: CGFloat = Tokens.Sizes.media
    let open: (Int) -> Void

    var body: some View {
        VStack(spacing: Tokens.Spacing.s2) {
            ForEach(Array(stride(from: 0, to: images.count, by: 2)), id: \.self) { start in
                let row = Array(images[start..<min(start + 2, images.count)])
                let total = row.map(\.aspect).reduce(0, +)
                GeometryReader { g in
                    let gap = Tokens.Spacing.s2 * CGFloat(row.count - 1)
                    let height = min(g.size.height, (g.size.width - gap) / total)
                    HStack(spacing: Tokens.Spacing.s2) {
                        ForEach(Array(row.enumerated()), id: \.offset) { i, image in
                            Thumb(image: image) { open(start + i) }
                                .frame(width: image.aspect * height, height: height)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .aspectRatio(total, contentMode: .fit)
                .frame(maxHeight: maxHeight)
            }
        }
    }
}

/** One image, its expand badge over it; tapping opens the viewer. */
struct Thumb: View {
    let image: SavedImage
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            ZStack(alignment: .bottomTrailing) {
                // Two to a row on the widest iPhone: about 650 px each.
                if let ui = image.decoded(maxEdge: 1024) {
                    Image(uiImage: ui).resizable().scaledToFit()
                } else {
                    Tokens.Colors.surface2.color
                }
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(6)
                    .background(Circle().fill(.black.opacity(0.55)))
                    .foregroundStyle(.white)
                    .padding(6)
            }
            .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(image.alt ?? "Image")
        .accessibilityHint("Opens it full screen")
    }
}

/** A question's images full screen: pinch to zoom, drag to pan, swipe between them. */
struct ImageViewer: View {
    let images: [SavedImage]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(images.enumerated()), id: \.offset) { i, image in
                    Zoomable(image: image).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .always : .never))
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: Tokens.Sizes.tap, height: Tokens.Sizes.tap)
            }
            .accessibilityLabel("Close")
        }
    }
}

private struct Zoomable: View {
    let image: SavedImage
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var start: CGSize = .zero

    var body: some View {
        Group {
            // Full size up to the pixel cap, so zooming shows real pixels.
            if let ui = image.decoded(maxEdge: SavedImage.maxEdge) {
                Image(uiImage: ui).resizable().scaledToFit()
            }
        }
        .scaleEffect(scale)
        .offset(offset)
        .gesture(
            MagnifyGesture()
                .onChanged { scale = max(1, base * $0.magnification) }
                .onEnded { _ in
                    base = scale
                    if scale == 1 { offset = .zero; start = .zero }
                }
        )
        // Panning only while zoomed, so a swipe at 1× moves to the next image.
        .simultaneousGesture(
            DragGesture()
                .onChanged { if scale > 1 { offset = CGSize(width: start.width + $0.translation.width, height: start.height + $0.translation.height) } }
                .onEnded { _ in start = offset },
            including: scale > 1 ? .all : .none
        )
        .onTapGesture(count: 2) {
            withAnimation {
                scale = scale > 1 ? 1 : 2
                base = scale
                offset = .zero
                start = .zero
            }
        }
        .accessibilityLabel(image.alt ?? "Image")
    }
}

/**
 * "Pick a result" (#536): with one image per option, each image over its option's button in
 * equal columns, at most `size.pick` tall, centred on one midline so the buttons line up.
 */
struct ImageOptions: View {
    let images: [SavedImage]
    let options: [String]
    let recommended: String?
    let amber: Bool
    let open: (Int) -> Void
    let answer: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s2) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, option in
                VStack(spacing: Tokens.Spacing.s2) {
                    Thumb(image: images[i]) { open(i) }
                        .frame(maxHeight: Tokens.Sizes.pick)
                    OptionButton(label: option, strong: sameOption(option, recommended), amber: amber, height: 48) { answer(option) }
                }
            }
        }
    }
}

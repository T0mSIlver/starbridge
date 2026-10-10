// The Needs you widget (#1031), the Mac's counterpart of Android's 2×2 (SPEC.md, "Desktop"). The
// app writes what the page counts into the App Group container (src/widgets.ts); this extension
// only reads that file and draws it: no network, no keys.

import CoreText
import SwiftUI
import WidgetKit

/** What the app last wrote: the page's Needs-you count, or why there is none. */
struct Snapshot: Codable, Equatable {
    /** "ready", "signedOut", or "closed" once the app quits. */
    var state: String
    var open: Int
    var waiting: Int

    static let closed = Snapshot(state: "closed", open: 0, waiting: 0)

    static func read() -> Snapshot {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "StarbridgeAppGroup") as? String,
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let data = try? Data(contentsOf: dir.appendingPathComponent("widgets.json")),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return .closed }
        return snapshot
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, snapshot: Snapshot(state: "ready", open: 2, waiting: 1))
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        let snapshot = Snapshot.read()
        // The gallery shows a live count when there is one, an example otherwise.
        completion(context.isPreview && snapshot.state != "ready" ? placeholder(in: context) : Entry(date: .now, snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        // The app asks for a reload whenever the count changes; the 30 minutes are a fallback, as
        // Android's launcher redraws.
        completion(Timeline(entries: [Entry(date: .now, snapshot: Snapshot.read())], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

/** DESIGN.md's tokens, both schemes; amber is the only colour. */
struct Palette {
    let card, amber, fg, fg2, accent: Color

    static func of(_ scheme: ColorScheme) -> Palette {
        scheme == .dark
            ? Palette(card: Color(hex: 0x171717), amber: Color(hex: 0xF5A83B, opacity: 0x1F), fg: Color(hex: 0xF1F1F1), fg2: Color(hex: 0xA3A3A3), accent: Color(hex: 0xF5A83B))
            : Palette(card: Color(hex: 0xFFFFFF), amber: Color(hex: 0x965700, opacity: 0x1A), fg: Color(hex: 0x121212), fg2: Color(hex: 0x595959), accent: Color(hex: 0x965700))
    }
}

extension Color {
    init(hex: UInt32, opacity: UInt32 = 0xFF) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: Double(opacity) / 255)
    }
}

/** Google Sans Flex, the app's face, from the extension's own Resources. */
enum Face {
    static let registered: Bool = {
        guard let url = Bundle.main.url(forResource: "GoogleSansFlex", withExtension: "ttf") else { return false }
        return CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }()

    static func of(_ size: CGFloat, medium: Bool = false) -> Font {
        let weight: Font.Weight = medium ? .medium : .regular
        return registered ? .custom("Google Sans Flex", fixedSize: size).weight(weight) : .system(size: size, weight: weight)
    }
}

/**
 * How many questions wait on the owner, amber only when an agent is blocked on one; else how many
 * are open. As Android's NeedsYouWidget.
 */
struct NeedsYouView: View {
    let snapshot: Snapshot
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Palette.of(scheme)
        let waiting = snapshot.state == "ready" ? snapshot.waiting : 0
        VStack(alignment: .leading, spacing: 0) {
            Text("Needs you").font(Face.of(13, medium: true)).foregroundStyle(p.fg2).lineLimit(1)
            Spacer(minLength: 0)
            switch snapshot.state {
            case "ready":
                Text("\(waiting > 0 ? waiting : snapshot.open)")
                    .font(Face.of(52, medium: true)).monospacedDigit()
                    .foregroundStyle(waiting > 0 ? p.accent : p.fg)
                    .widgetAccentable(waiting > 0)
                    .lineLimit(1).minimumScaleFactor(0.5)
                Text(waiting > 0 ? "waiting on you" : snapshot.open > 0 ? "when you can" : "nothing open")
                    .font(Face.of(15)).foregroundStyle(p.fg).lineLimit(1)
                let rest = snapshot.open - waiting
                Text(waiting > 0 && rest > 0 ? "\(rest) more when you can" : " ")
                    .font(Face.of(12)).foregroundStyle(p.fg2).lineLimit(1).padding(.top, 2)
            case "signedOut":
                Text("Not signed in").font(Face.of(15)).foregroundStyle(p.fg)
            default:
                Text("Starbridge is closed").font(Face.of(15)).foregroundStyle(p.fg)
                Text("Click to open it").font(Face.of(12)).foregroundStyle(p.fg2).padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            ZStack {
                p.card
                if waiting > 0 { p.amber }
            }
        }
        .widgetURL(URL(string: "starbridge://inbox"))
    }
}

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "needs-you", provider: Provider()) { entry in
            NeedsYouView(snapshot: entry.snapshot)
        }
        .configurationDisplayName("Needs you")
        .description("Questions waiting on you, amber while an agent is blocked.")
        .supportedFamilies([.systemSmall])
    }
}

@main
struct StarbridgeWidgets: WidgetBundle {
    var body: some Widget {
        NeedsYouWidget()
    }
}

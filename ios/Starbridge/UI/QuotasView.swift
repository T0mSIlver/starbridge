import SwiftUI

/** One card per provider, its windows inside, in the settings' order (spec/items.md, "Quota order"), as Android's. */
struct QuotasView: View {
    let store: Store
    /** Asked the machines once for a snapshot sealed to this iPhone (#661). */
    @State private var asked = false

    var body: some View {
        let settings = store.quotaSettings
        let windows = store.quotaWindows
        let failures = store.quotaFailures
        let machines = store.machineNames
        let none = windows.isEmpty && failures.isEmpty
        // A device that just joined has no snapshot sealed to it yet, and quota items send no push:
        // ask the machines once, as a pull does, instead of waiting for their next upload.
        let ask = none && !(machines ?? []).isEmpty
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = context.date
                let groups = settings.groups(settings.arrange(windows, now))
                let failed = failures.filter { !settings.hidden.contains($0.provider) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Tokens.Spacing.s2) {
                        if let updated = windows.compactMap(\.takenAt).max() {
                            Text("Updated \(Times.ago(updated, now))")
                                .type(Tokens.Typography.meta)
                                .foregroundStyle(Tokens.Colors.fg3.color)
                                .padding(.horizontal, Tokens.Spacing.s1)
                        }
                        if none {
                            NoQuotas(machines: machines, asking: store.quotasAsking || (ask && !asked))
                        } else if groups.isEmpty, failed.isEmpty {
                            Text("Every provider is hidden")
                                .type(Tokens.Typography.body)
                                .foregroundStyle(Tokens.Colors.fg2.color)
                                .padding(Tokens.Spacing.s4)
                        }
                        ForEach(groups, id: \.first!.id) { g in
                            ProviderCard(provider: g[0].provider, machine: g[0].machine, error: g[0].error, takenAt: g[0].takenAt, windows: g, now: now, settings: settings)
                        }
                        // After the windows: a provider with none to show says only why.
                        ForEach(failed, id: \.key) { f in
                            ProviderCard(provider: f.provider, machine: f.machine, error: f.error, takenAt: nil, windows: [], now: now, settings: settings)
                        }
                    }
                    .padding(.horizontal, Tokens.Spacing.s3)
                    .padding(.bottom, Tokens.Spacing.s6)
                }
            }
            .refreshable { await store.refreshQuotas() }
            .background(Tokens.Colors.bg.color.ignoresSafeArea())
            .navigationTitle("Quotas")
        }
        .task(id: ask) {
            guard ask, !asked else { return }
            asked = true
            await store.refreshQuotas()
        }
    }
}

/** "devbox", "devbox and laptop", "devbox, laptop and pi". */
func machineList(_ machines: [String]) -> String {
    switch machines.count {
    case 0: ""
    case 1: machines[0]
    default: machines.dropLast().joined(separator: ", ") + " and " + machines.last!
    }
}

/** No snapshot yet: whose quotas are on the way, or why none come. `machines` nil: the directory has not loaded. */
private struct NoQuotas: View {
    let machines: [String]?
    let asking: Bool

    static let docs = URL(string: "https://starbridge.run/docs/cli")!

    var body: some View {
        VStack(spacing: Tokens.Spacing.s4) {
            Image(systemName: "gauge.with.dots.needle.33percent")
                .font(.system(size: 56))
                .frame(width: 160, height: 160)
                .background(Circle().fill(Tokens.Colors.surface2.color))
                .accessibilityHidden(true)
            Text(heading)
                .type(Tokens.Typography.heading)
                .multilineTextAlignment(.center)
            if let machines, machines.isEmpty {
                Text("Quotas come from the machines that run your agents. Add one from the Inbox.")
                    .type(Tokens.Typography.body)
                    .foregroundStyle(Tokens.Colors.fg2.color)
                    .multilineTextAlignment(.center)
            } else if machines != nil, !asking {
                Text("A machine uploads quotas once CodexBar reads an AI plan there. Run setup on it and say yes to quotas:")
                    .type(Tokens.Typography.body)
                    .foregroundStyle(Tokens.Colors.fg2.color)
                    .multilineTextAlignment(.center)
                Text("starbridge setup")
                    .type(Tokens.Typography.code)
                    .textSelection(.enabled)
                    .padding(Tokens.Spacing.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.surface2.color))
                Link(destination: Self.docs) {
                    Text("How to set it up").type(Tokens.Typography.action)
                }
                .buttonStyle(.bordered)
                .frame(minHeight: Tokens.Sizes.tap)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.s4)
        .padding(.vertical, Tokens.Spacing.s10)
    }

    private var heading: String {
        guard let machines else { return "No quotas yet" }
        if machines.isEmpty { return "No machine yet" }
        return asking ? "Loading quotas from \(machineList(machines))…" : "No quotas from \(machineList(machines))"
    }
}

/**
 * A provider's name, the machine that sent its windows when there are several, and the windows.
 * When CodexBar failed for it, its last windows stay, and the name says when they were read and
 * why they were not read again. A provider with no windows to keep shows only why (#450).
 */
private struct ProviderCard: View {
    let provider: String
    let machine: String?
    let error: String?
    let takenAt: Date?
    let windows: [QuotaRow]
    let now: Date
    let settings: QuotaSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The machine at the end of the provider's line, or on a line of its own when both don't fit.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    Text(provider).type(Tokens.Typography.subtitle)
                    Spacer(minLength: Tokens.Spacing.s2)
                    machineText
                }
                VStack(alignment: .leading) {
                    Text(provider).type(Tokens.Typography.subtitle)
                    machineText
                }
            }
            if let error {
                VStack(alignment: .leading, spacing: 0) {
                    if let takenAt { Text("Updated \(Times.ago(takenAt, now))") }
                    Text(error)
                }
                .type(Tokens.Typography.meta)
                .foregroundStyle(Tokens.Colors.fg2.color)
                .padding(.top, Tokens.Spacing.s1)
            }
            ForEach(Array(windows.enumerated()), id: \.element.id) { i, w in
                if i > 0 {
                    Rectangle().fill(Tokens.Colors.line.color).frame(height: 1).padding(.top, Tokens.Spacing.s4)
                }
                WindowRow(window: w, now: now, settings: settings)
                    .padding(.top, i > 0 ? Tokens.Spacing.s4 : Tokens.Spacing.s3)
            }
        }
        .padding(Tokens.Spacing.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.surface.color))
    }

    @ViewBuilder private var machineText: some View {
        if let machine { Text(machine).type(Tokens.Typography.meta).foregroundStyle(Tokens.Colors.fg2.color) }
    }
}

/** A window's state in words (DESIGN.md: the words carry the state, never a colour alone), and its colour. */
enum QuotaState {
    enum Mood { case ok, bad, warn, neutral }

    static func of(_ w: QuotaRow, _ now: Date, absolute: Bool) -> (Mood, String) {
        if w.ended(now) { return (.neutral, "Window reset") }
        switch w.pace {
        case .even: return (.ok, "On pace")
        case let .runsOut(at):
            if at <= now { return (.bad, "Ran out \(Times.clockAt(at, now))") }
            return (.bad, absolute ? "Will run out \(Times.clockAt(at, now))" : "Will run out in \(Times.span(now, at))")
        case .unused: return (.warn, "Headroom unused")
        case .unknown: return (.neutral, "Too early to tell")
        }
    }

    /** "Resets in 2 h", "Resets at 14:20", "Reset 5 min ago". */
    static func reset(_ w: QuotaRow, _ now: Date, absolute: Bool) -> String {
        guard let at = w.resetsAt else { return "Reset time unknown" }
        if w.ended(now) { return "Reset \(Times.ago(at, now))" }
        return absolute ? "Resets \(Times.clockAt(at, now))" : "Resets in \(Times.span(now, at))"
    }
}

private struct WindowRow: View {
    let window: QuotaRow
    let now: Date
    let settings: QuotaSettings
    @ScaledMetric(relativeTo: .body) private var figure = Tokens.Typography.figure.size
    @ScaledMetric(relativeTo: .body) private var label = Tokens.Typography.label.size

    var body: some View {
        let (mood, word) = QuotaState.of(window, now, absolute: settings.absoluteResets)
        let ended = window.ended(now)
        let course = window.course(now)
        let bar = settings.bar(window, now)
        let percent = course == .ranOut && settings.showUsed ? 100 : bar.percent
        VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.window)
                    .type(Tokens.Typography.body)
                    .lineLimit(2)
                Spacer(minLength: Tokens.Spacing.s2)
                Text("\(Text("\(percent)").font(.system(size: figure, weight: .semibold).monospacedDigit()))\(Text("%").font(.system(size: label, weight: .medium)))")
                    .foregroundStyle(ended ? Tokens.Colors.fg2.color : Tokens.Colors.fg.color)
            }
            Meter(bar: bar, course: course, provider: Tokens.providerColor(window.provider), showUsed: settings.showUsed)
            // The pace and the reset time on one line, or two when both don't fit.
            ViewThatFits(in: .horizontal) {
                HStack {
                    paceText(mood, word)
                    Spacer(minLength: Tokens.Spacing.s2)
                    resetText
                }
                VStack(alignment: .leading) {
                    paceText(mood, word)
                    resetText
                }
            }
        }
    }

    private func paceText(_ mood: QuotaState.Mood, _ word: String) -> some View {
        let color: Pair = switch mood {
        case .ok: Tokens.Colors.ok
        case .bad: Tokens.Colors.bad
        case .warn: Tokens.Colors.warn
        case .neutral: Tokens.Colors.fg2
        }
        return Text(word).type(Tokens.Typography.meta).fontWeight(.medium).foregroundStyle(color.color)
    }

    private var resetText: some View {
        Text(QuotaState.reset(window, now, absolute: settings.absoluteResets))
            .type(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Colors.fg2.color)
            .lineLimit(1)
    }
}

extension Tokens {
    /** A provider's quota fill, by CodexBar id with anything but letters and digits dropped; unknown ones are grey. */
    static func providerColor(_ provider: String) -> Color {
        let key = String(provider.lowercased().unicodeScalars.filter { ("a"..."z").contains($0) || ("0"..."9").contains($0) }.map(Character.init))
        return (providers[key] ?? Colors.fg3).color
    }
}

/**
 * A window's use (DESIGN.md, "Quota bars"), as Android's Meter: the fill in the provider's colour,
 * then a gap and the track with its stop dot. A window that will run out waves, and the part the
 * current pace uses before the reset is hatched up to a red cap at the limit; one that ran out is
 * full, with the cap. The pace tick marks where a steady pace would be now; workday ticks cut the
 * bar in the card's colour.
 */
struct Meter: View {
    let bar: QuotaSettings.Bar
    let course: Course
    let provider: Color
    let showUsed: Bool

    var body: some View {
        // Ran out: full when the bar shows use, empty when it shows what's left.
        let fill = min(max(course == .ranOut && showUsed ? 1 : Double(bar.percent) / 100, 0), 1)
        let h = Tokens.Sizes.track
        let track = Tokens.Colors.surface2.color
        let card = Tokens.Colors.surface.color
        let pace = Tokens.Colors.fg.color
        let dot = Tokens.Colors.fg3.color
        let bad = Tokens.Colors.bad.color
        Canvas { ctx, size in
            let w = size.width
            let reach = h / 2
            let top = reach
            let gap = Tokens.Sizes.cap
            let x = fill * w
            let burning = course == .willRunOut
            let full = fill >= 1
            let trackStart = x > 0 ? x + gap : 0
            func pill(_ r: CGRect) -> Path { Path(roundedRect: r, cornerRadius: r.height / 2) }
            if !full, trackStart < w { ctx.fill(pill(CGRect(x: trackStart, y: top, width: w - trackStart, height: h)), with: .color(track)) }
            let fillEnd = full ? w : max(x - 2, 0)
            if fillEnd > 0 {
                if burning, showUsed {
                    wave(&ctx, provider, end: fillEnd, mid: top + h / 2)
                } else {
                    ctx.fill(pill(CGRect(x: 0, y: top, width: fillEnd, height: h)), with: .color(provider))
                }
            }
            if burning {
                // Used: the overrun follows the fill. Left: what's left is the part the pace burns.
                if showUsed { hatch(&ctx, provider.opacity(0.9), from: trackStart, to: w, top: top, h: h) } else { hatch(&ctx, card.opacity(0.55), from: 0, to: fillEnd, top: top, h: h) }
            }
            for t in bar.ticks {
                ctx.fill(Path(CGRect(x: t * w - Tokens.Sizes.cap / 2, y: top, width: Tokens.Sizes.cap, height: h)), with: .color(card))
            }
            if course == .steady, !full {
                let d = Tokens.Sizes.cap
                ctx.fill(Path(ellipseIn: CGRect(x: w - 3 - d, y: top + 3, width: d, height: d)), with: .color(dot))
            }
            if course != .steady {
                let cw = Tokens.Sizes.cap
                let cx = showUsed ? w - cw / 2 : -cw / 2
                ctx.fill(pill(CGRect(x: cx, y: 0, width: cw, height: h + 2 * reach)), with: .color(bad))
            }
            if course != .ranOut, let steady = bar.steady {
                let tw = Tokens.Sizes.cap
                ctx.fill(pill(CGRect(x: Double(steady) / 100 * w - tw / 2, y: 0, width: tw, height: h + 2 * reach)), with: .color(pace))
            }
        }
        // Ten points tall; the pace tick and the cap reach 5 past it each way.
        .frame(height: h * 2)
        .padding(.vertical, -h / 2)
        .animation(.smooth, value: fill)
        .accessibilityElement()
        .accessibilityLabel("\(bar.percent)% \(bar.word)" + (bar.steady.map { ", steady pace \($0)%" } ?? ""))
    }

    /** "Running now": period 20, amplitude 3, a 4-point stroke. */
    private func wave(_ ctx: inout GraphicsContext, _ color: Color, end: Double, mid: Double) {
        let period = 20.0, amp = 3.0
        var path = Path()
        path.move(to: CGPoint(x: 0, y: mid))
        var x = 0.0
        while x < end {
            path.addQuadCurve(to: CGPoint(x: x + period / 2, y: mid), control: CGPoint(x: x + period / 4, y: mid - amp * 2))
            path.addQuadCurve(to: CGPoint(x: x + period, y: mid), control: CGPoint(x: x + period * 3 / 4, y: mid + amp * 2))
            x += period
        }
        var clipped = ctx
        clipped.clip(to: Path(CGRect(x: 0, y: 0, width: end, height: mid * 2)))
        clipped.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 4, lineCap: .round))
    }

    /** Stripes rising at 45°, `Sizes.hatch` apart, 2 wide, in a rounded bar from `from` to `to`. */
    private func hatch(_ ctx: inout GraphicsContext, _ color: Color, from: Double, to: Double, top: Double, h: Double) {
        guard to > from else { return }
        var clipped = ctx
        clipped.clip(to: Path(roundedRect: CGRect(x: from, y: top, width: to - from, height: h), cornerRadius: h / 2))
        let step = Tokens.Sizes.hatch * 1.4142
        var x = from - h
        var stripes = Path()
        while x < to {
            stripes.move(to: CGPoint(x: x, y: top + h))
            stripes.addLine(to: CGPoint(x: x + h, y: top))
            x += step
        }
        clipped.stroke(stripes, with: .color(color), lineWidth: 2)
    }
}

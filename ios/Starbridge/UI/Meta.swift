import StarbridgeProtocol
import SwiftUI

/** How long times read on cards, as Android writes them. */
enum Times {
    /** "12 min", "1 h 5 min", "2 d 3 h". */
    static func span(_ from: Date, _ to: Date) -> String {
        let minutes = max(0, Int(to.timeIntervalSince(from) / 60))
        let d = minutes / (60 * 24), h = minutes / 60 % 24, m = minutes % 60
        if d > 0 { return h > 0 ? "\(d) d \(h) h" : "\(d) d" }
        if h > 0 { return m > 0 ? "\(h) h \(m) min" : "\(h) h" }
        return "\(m) min"
    }

    /** An item's age: "now" under a minute. */
    static func since(_ then: Date, _ now: Date) -> String { now.timeIntervalSince(then) < 60 ? "now" : span(then, now) }

    /** "1:12" under an hour, then "1 h 5 min": how long an agent has waited, by the second. */
    static func waited(_ since: Date, _ now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(since)))
        return s < 3600 ? "\(s / 60):\(String(format: "%02d", s % 60))" : span(since, now)
    }

    /** What a screen reader hears first on an item that blocks an agent. */
    static func waitingLabel(_ since: Date, _ now: Date) -> String {
        let m = max(0, Int(now.timeIntervalSince(since) / 60))
        return "Waiting for you, " + (m == 0 ? "under a minute" : m == 1 ? "1 minute" : "\(m) minutes")
    }

    /** "18:00", or "Fri 09:00" on another day: when a snooze ends. */
    static func clock(_ date: Date, _ now: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDate(date, inSameDayAs: now) { return time }
        return date.formatted(.dateTime.weekday(.abbreviated)) + " " + time
    }

    /** "just now", "12 min ago". */
    static func ago(_ then: Date, _ now: Date) -> String { now.timeIntervalSince(then) < 60 ? "just now" : span(then, now) + " ago" }

    /**
     * A clock time in a sentence: "at 15:55" today, "tomorrow at 10:15", "yesterday at 10:15",
     * else "on Oct 8 at 10:15".
     */
    static func clockAt(_ date: Date, _ now: Date, _ calendar: Calendar = .current) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "at \(time)" }
        if let next = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: next) { return "tomorrow at \(time)" }
        if let last = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: last) { return "yesterday at \(time)" }
        return "on \(date.formatted(.dateTime.month(.abbreviated).day())) at \(time)"
    }

    /** "1 min 05 s", "2 h 03 min": a run's time. */
    static func elapsed(_ from: Date, _ to: Date) -> String {
        let s = max(0, Int(to.timeIntervalSince(from)))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min \(String(format: "%02d", s % 60)) s" }
        return "\(s / 3600) h \(String(format: "%02d", s % 3600 / 60)) min"
    }
}

/** The machine's kind as its symbol; a machine that predates kinds is a computer. */
func machineSymbol(_ kind: MachineKind?) -> String {
    switch kind {
    case .server: "server.rack"
    case .desktop: "desktopcomputer"
    case .laptop: "laptopcomputer"
    case .cloud: "cloud"
    case nil: "desktopcomputer"
    }
}

/**
 * The one meta row: the machine's kind and name, the repo, then `time` at the end, in amber at
 * weight 500 while an agent waits (`clock`), as the time slot is the only place that state shows.
 */
struct MetaRow: View {
    let source: Source
    let time: String
    var clock = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: machineSymbol(source.machineKind)).font(.system(size: 14)).accessibilityHidden(true)
            Text([source.machine, source.project].filter { !$0.isEmpty }.joined(separator: " · "))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !time.isEmpty {
                Text(time)
                    .fontWeight(clock ? .medium : .regular)
                    .foregroundStyle(clock ? Tokens.Colors.accent.color : Tokens.Colors.fg2.color)
                    .lineLimit(1)
            }
        }
        .type(Tokens.Typography.machine)
        .foregroundStyle(Tokens.Colors.fg2.color)
    }
}

/** The agent's app, for "Open in": by the machine's word for it, else by the session's link. */
func agentName(_ agent: String?, _ source: Source) -> String? {
    switch agent {
    case "codex": "Codex"
    case "claude-code": "Claude"
    case nil where source.links?.contains { $0.url.hasPrefix("https://claude.ai/") } == true: "Claude"
    default: nil
    }
}

/**
 * The end of a detail (#970): the session's name, opening the session in Claude or Codex when it
 * has a link; a session with no name the owner gave shows "Open in Claude" alone.
 */
struct SessionLine: View {
    let source: Source
    let agent: String?

    var body: some View {
        let name = source.sessionTitle?.trimmingCharacters(in: .whitespaces) ?? ""
        let link = source.links?.first { $0.kind != .desktop }.flatMap { URL(string: $0.url) }
        let app = agentName(agent, source)
        let text = !name.isEmpty ? name : (link != nil && app != nil ? "Open in \(app!)" : "")
        if !text.isEmpty {
            HStack {
                Spacer()
                if let link, app != nil {
                    Link(destination: link) {
                        HStack(spacing: Tokens.Spacing.s1) {
                            Text(text).underline().lineLimit(1).truncationMode(.middle)
                            Image(systemName: "arrow.up.right").font(.system(size: 13))
                        }
                    }
                    .foregroundStyle(Tokens.Colors.fg.color)
                    .accessibilityHint("Opens the session in \(app!)")
                } else {
                    Text(text).lineLimit(1).truncationMode(.middle).foregroundStyle(Tokens.Colors.fg2.color)
                }
            }
            .type(Tokens.Typography.small)
            .frame(minHeight: Tokens.Sizes.tap)
        }
    }
}

/**
 * An agent's context in the subset the skill names (#969): each line on its own, bold, code
 * inline and fenced, lists with a hanging indent, and links.
 */
struct ContextView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s1) {
            ForEach(Array(parseContext(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case let .line(spans):
                    Text(Self.attributed(spans))
                case let .item(marker, spans):
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s2) {
                        Text(marker).monospacedDigit()
                        Text(Self.attributed(spans))
                    }
                case let .code(code):
                    ScrollView(.horizontal) {
                        Text(code).type(Tokens.Typography.snippet).padding(Tokens.Spacing.s3)
                    }
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.sm).fill(Tokens.Colors.surface2.color))
                }
            }
        }
        .type(Tokens.Typography.reading)
        .foregroundStyle(Tokens.Colors.fg.color)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func attributed(_ spans: [Span]) -> AttributedString {
        var out = AttributedString()
        for span in spans {
            var a = AttributedString(span.text)
            if span.bold { a.inlinePresentationIntent = .stronglyEmphasized }
            if span.code { a.inlinePresentationIntent = .code }
            if let href = span.href, let url = URL(string: href) {
                a.link = url
                a.underlineStyle = .single
            }
            out += a
        }
        return out
    }
}

/** A filled answer button: the recommended option in amber while its agent waits, else in `fg`. */
struct OptionButton: View {
    let label: String
    let strong: Bool
    let amber: Bool
    var height: CGFloat = 44
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .type(Tokens.Typography.action)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: height)
                .padding(.horizontal, Tokens.Spacing.s3)
                .foregroundStyle(strong ? (amber ? Tokens.Colors.onAccent.color : Tokens.Colors.bg.color) : Tokens.Colors.fg.color)
                .background(
                    Capsule().fill(strong ? (amber ? Tokens.Colors.accent.color : Tokens.Colors.fg.color) : Tokens.Colors.surface2.color)
                )
        }
        .buttonStyle(.plain)
        .accessibilityValue(strong ? "Default" : "")
    }
}

/** A question's options, the default first: in a row when two short ones fit, else stacked (#138). */
struct Options: View {
    let decision: Decision
    let amber: Bool
    var height: CGFloat = 44
    let answer: (String) -> Void

    var body: some View {
        let stack = decision.options.count > 2 || decision.options.contains { $0.count > 18 }
        let layout = stack ? AnyLayout(VStackLayout(spacing: Tokens.Spacing.s2)) : AnyLayout(HStackLayout(spacing: Tokens.Spacing.s2))
        layout {
            // By place, not text: two options may differ only by code points.
            ForEach(Array(decision.ordered.enumerated()), id: \.offset) { _, o in
                OptionButton(label: o, strong: sameOption(o, decision.recommended), amber: amber, height: height) { answer(o) }
            }
        }
    }
}

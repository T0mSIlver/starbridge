import StarbridgeProtocol
import SwiftUI

/**
 * A question opened: its words, its options, the reply field, and the session line. Answered from
 * here, the sheet goes at the tap (#927); a refused answer comes back in the list.
 */
struct DecisionDetail: View {
    let store: Store
    let id: String
    let close: () -> Void
    @State private var viewer: ViewerStart?

    var body: some View {
        if let d = store.decision(id) {
            let open = d.isOpen && store.unsent[id] == nil
            let until = d.snoozed
            let waiting = d.waiting == "waiting" && until == nil
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let since = waiting ? d.waitingAt.flatMap(Dates.parse) : nil
                        MetaRow(
                            source: d.body.source,
                            time: since.map { Times.waited($0, context.date) } ?? Dates.parse(d.body.createdAt).map { Times.since($0, context.date) } ?? "",
                            clock: waiting
                        )
                    }
                    Text(d.body.question).type(Tokens.Typography.question).textSelection(.enabled)
                    if !d.body.context.isEmpty { ContextView(text: d.body.context) }
                    // Images over their options when there is one per option; else in rows (#536).
                    let picks = open && d.images.count >= 2 && d.images.count == d.body.options.count
                    if !d.images.isEmpty, !picks { ImageRows(images: d.images) { viewer = ViewerStart(index: $0) } }
                    if d.imagesPending { PendingImages(images: d.body.images ?? []) }
                    if let links = d.body.links, !links.isEmpty { LinkChips(links: links, project: d.body.source.project) }
                    if let until {
                        Text("Snoozed until \(Times.clock(until, Date()))").type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color)
                    }
                    if let why = store.notSent[id] {
                        Text("Not sent: \(why)").type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.bad.color)
                    }
                    if open {
                        if picks {
                            ImageOptions(images: d.images, options: d.body.options, recommended: d.body.recommended, amber: waiting, open: { viewer = ViewerStart(index: $0) }) {
                                store.answer(id, choice: $0, text: nil)
                                close()
                            }
                        }
                        Answering(store: store, decision: d, amber: waiting, options: !picks) { close() }
                        // Done for a page's answer (#539) and putting it off (#571), on the session's line (#970).
                        let page = d.body.answerIn != nil && d.body.done == true
                        SnoozeControls(store: store, id: id, until: until, session: d.body.source, agent: d.body.agent, markDone: page ? {
                            store.answer(id, choice: nil, text: nil)
                            close()
                        } : nil) { close() }
                    } else {
                        Text(HistoryText.how(d, store)).type(Tokens.Typography.body).foregroundStyle(Tokens.Colors.fg2.color).textSelection(.enabled)
                        SessionLine(source: d.body.source, agent: d.body.agent)
                    }
                }
                .padding(Tokens.Spacing.s5)
            }
            .foregroundStyle(Tokens.Colors.fg.color)
            .background(Tokens.Colors.bg.color.ignoresSafeArea())
            .fullScreenCover(item: $viewer) { ImageViewer(images: d.images, index: $0.index) }
            .task(id: id) { await store.loadImages(id) }
        } else {
            Text("This question is gone.").type(Tokens.Typography.body).padding()
        }
    }
}

/**
 * What History says of an answered question, shared by its row and its detail: the answer, then
 * who closed it, as on the web and Android ("Hold · on Pixel", "Answered · at the keyboard").
 */
enum HistoryText {
    @MainActor static func how(_ d: SavedDecision, _ store: Store) -> String {
        let unsent = store.unsent[d.id]
        let withdrawn = d.settled == "withdrawn"
        let answer = unsent ?? d.answer ?? d.theirAnswer ?? (withdrawn ? "Withdrawn" : d.body.answerIn.map(Store.doneText) ?? "Answered")
        return "\(answer) · \(by(d, store, sending: unsent != nil))"
    }

    /**
     * Who closed it: "not sent yet", "on this iPhone", "on Pixel", "at the keyboard" (the agent's
     * own picker, #865), the agent's reason for a withdrawal (#1008), "by the agent" (withdrawn
     * without one, or for another page), "on another device".
     */
    @MainActor private static func by(_ d: SavedDecision, _ store: Store, sending: Bool) -> String {
        if sending { return "not sent yet" }
        if d.answer != nil { return "on this iPhone" }
        if let by = d.answeredBy { return "on \(store.memberName(by))" }
        // Only a question without a page was answered in the agent's own picker (#865, #1157).
        if d.settled == "elsewhere", d.body.answerIn == nil { return "at the keyboard" }
        if d.settled == "withdrawn", let reason = d.reason { return reason }
        return d.settled != nil || d.body.answerIn != nil ? "by the agent" : "on another device"
    }
}

/** The ways to answer an open question: its page, its options, and the reply field. */
private struct Answering: View {
    let store: Store
    let decision: SavedDecision
    let amber: Bool
    var options = true
    let answered: () -> Void

    var body: some View {
        let body = decision.body
        VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            if let page = body.answerIn, let url = URL(string: page.url) {
                // Answered on its page, never here; Done says the owner did (#539).
                Link(destination: url) {
                    HStack(spacing: Tokens.Spacing.s2) {
                        Image(systemName: "arrow.up.right").accessibilityHidden(true)
                        Text("Answer in \(Notify.place(page))").lineLimit(1)
                    }
                    .type(Tokens.Typography.action)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .foregroundStyle(Tokens.Colors.onAccent.color)
                    .background(Capsule().fill(Tokens.Colors.accent.color))
                }
            } else {
                if options, !body.options.isEmpty {
                    Options(decision: body, amber: amber, height: 48) { send($0, nil) }
                }
                // A question with options takes a typed reply only when it says so (#201).
                if body.options.isEmpty || body.replies == true {
                    ReplyField(store: store, id: decision.id, placeholder: "Your answer") { send(nil, $0) }
                }
            }
        }
    }

    private func send(_ choice: String?, _ text: String?) {
        store.answer(decision.id, choice: choice, text: text)
        answered()
    }
}

/**
 * Snooze, under the reply field (#571): it opens the times in place: 1 hour and This evening, the
 * days as chips, a time, and "Snooze until 15:00". A snoozed question offers Snooze again and Back now.
 * In a question's detail the row is the session's line: the session at the start, then Done, Back
 * now and Snooze, which is a round icon button (#970, #1848).
 */
struct SnoozeControls: View {
    let store: Store
    let id: String
    let until: Date?
    var session: Source?
    var agent: String?
    /** Done for a question answered on its page (#539). */
    var markDone: (() -> Void)?
    let done: () -> Void
    @State private var open: Bool
    @State private var day: Date
    @State private var time: Date

    /** `open`: the times show at once, as over the inbox after a swipe (#692). */
    init(
        store: Store, id: String, until: Date?, open: Bool = false,
        session: Source? = nil, agent: String? = nil, markDone: (() -> Void)? = nil, done: @escaping () -> Void
    ) {
        self.store = store
        self.id = id
        self.until = until
        self.session = session
        self.agent = agent
        self.markDone = markDone
        self.done = done
        let now = Date()
        let today = Calendar.current.startOfDay(for: now)
        _open = State(initialValue: open)
        _day = State(initialValue: today)
        _time = State(initialValue: open ? SnoozeTimes.start(today, now) : now)
    }

    var body: some View {
        let now = Date()
        VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            HStack(spacing: Tokens.Spacing.s4) {
                if let session {
                    SessionLink(source: session, agent: agent).type(Tokens.Typography.small)
                }
                Spacer(minLength: Tokens.Spacing.s2)
                if let markDone { quiet("Done", markDone) }
                if until != nil { quiet("Back now") { snooze(Date()) } }
                Button {
                    withAnimation { open.toggle() }
                    day = Calendar.current.startOfDay(for: now)
                    time = SnoozeTimes.start(day, now)
                } label: {
                    Image(systemName: "moon.zzz")
                        .font(.system(size: 20))
                        .foregroundStyle(Tokens.Colors.fg.color)
                        .frame(width: Tokens.Sizes.tap, height: Tokens.Sizes.tap)
                        .background(Circle().fill(Tokens.Colors.surface2.color))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(until == nil ? "Snooze" : "Snooze again")
            }
            if open {
                ForEach(SnoozeTimes.presets(now), id: \.0) { name, at in
                    Button { snooze(at) } label: {
                        HStack {
                            Text(name).type(Tokens.Typography.body)
                            Spacer()
                            Text(Times.clock(at, now)).type(Tokens.Typography.machine).foregroundStyle(Tokens.Colors.fg2.color)
                        }
                        .frame(minHeight: Tokens.Sizes.tap)
                        .padding(.horizontal, Tokens.Spacing.s4)
                        .background(RoundedRectangle(cornerRadius: Tokens.Radius.md).fill(Tokens.Colors.surface.color))
                    }
                    .buttonStyle(.plain)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Tokens.Spacing.s2) {
                        ForEach(SnoozeTimes.days(now), id: \.self) { d in
                            let chosen = Calendar.current.isDate(d, inSameDayAs: day)
                            Button {
                                day = d
                                time = SnoozeTimes.start(d, now)
                            } label: {
                                Text(SnoozeTimes.label(d, now))
                                    .type(Tokens.Typography.label)
                                    .padding(.horizontal, Tokens.Spacing.s4)
                                    .frame(minHeight: 36)
                                    .foregroundStyle(chosen ? Tokens.Colors.bg.color : Tokens.Colors.fg.color)
                                    .background(Capsule().fill(chosen ? Tokens.Colors.fg.color : Tokens.Colors.surface2.color))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                        }
                    }
                }
                DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    .type(Tokens.Typography.body)
                let at = Self.combine(day, time)
                OptionButton(label: "Snooze until \(Times.clock(at, now))", strong: true, amber: false, height: 48) { snooze(at) }
                    .disabled(!SnoozeTimes.allowed(at, now))
                    .opacity(SnoozeTimes.allowed(at, now) ? 1 : 0.38)
            }
        }
    }

    private func quiet(_ text: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(text).type(Tokens.Typography.action).foregroundStyle(Tokens.Colors.fg2.color) }
            .buttonStyle(.plain)
            .frame(minHeight: Tokens.Sizes.tap)
    }

    private func snooze(_ at: Date) {
        done()
        Task { await store.snooze(id, until: at) }
    }

    /** The chosen day at the picker's hour and minute. */
    static func combine(_ day: Date, _ time: Date) -> Date {
        let c = Calendar.current
        let hm = c.dateComponents([.hour, .minute], from: time)
        return c.date(bySettingHour: hm.hour ?? 9, minute: hm.minute ?? 0, second: 0, of: day) ?? day
    }
}

/**
 * The reply field: grows to 10 lines, then scrolls (#947), and keeps a draft with its question
 * while the app runs (#992), until its answer is queued. Return starts a new line; the arrow sends.
 */
private struct ReplyField: View {
    let store: Store
    let id: String
    let placeholder: String
    let send: (String) -> Void

    var body: some View {
        // Capped as the Answer schema caps its text, so a reply always seals (#1169).
        let draft = Binding(get: { store.drafts[id] ?? "" }, set: { store.drafts[id] = Store.capped($0) })
        let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s2) {
            TextField(placeholder, text: draft, axis: .vertical)
                .lineLimit(1...10)
                .type(Tokens.Typography.body)
            Button {
                // The draft stays until the answer is queued (Store.answer).
                send(text)
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
            }
            .disabled(text.isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, Tokens.Spacing.s4)
        .padding(.vertical, Tokens.Spacing.s2)
        .frame(minHeight: 56)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.md).fill(Tokens.Colors.surface2.color))
    }
}

/**
 * A permission prompt opened: what the agent wants to run, the full input, and the answers. A
 * deny may carry a note to the agent; a wider allow only takes a scope the prompt offered.
 */
struct PromptDetail: View {
    let store: Store
    let id: String
    let close: () -> Void
    @State private var note = ""
    @State private var seen = false

    var body: some View {
        if let p = store.prompt(id) {
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
                    MetaRow(source: p.body.source, time: Dates.parse(p.body.createdAt).map { Times.since($0, Date()) } ?? "")
                    Text(p.headline).type(Tokens.Typography.question)
                    // The whole input; Allow waits until its end has been on screen (#274).
                    Text(p.fullInput)
                        .type(Tokens.Typography.code)
                        .textSelection(.enabled)
                        .padding(Tokens.Spacing.s4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(Tokens.Colors.onTerminal.color)
                        .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.terminal.color))
                    Color.clear.frame(height: 1).background(
                        GeometryReader { g in
                            Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in
                                if y < UIScreen.main.bounds.height { seen = true }
                            }
                        }
                    )
                    if p.isOpen {
                        VStack(spacing: Tokens.Spacing.s2) {
                            OptionButton(label: "Allow", strong: true, amber: true, height: 48) { answer(p, allow: true, .once) }
                                .disabled(!seen)
                                .opacity(seen ? 1 : 0.38)
                            // Each wider allow shows the exact rule it adds (PROTOCOL.md).
                            ForEach(p.body.suggestions, id: \.rule) { s in
                                VStack(alignment: .leading, spacing: Tokens.Spacing.s1) {
                                    OptionButton(label: s.label, strong: false, amber: true, height: 48) { answer(p, allow: true, s.scope) }
                                    Text(visible(s.rule)).type(Tokens.Typography.snippet).foregroundStyle(Tokens.Colors.fg2.color)
                                }
                                .disabled(!seen)
                                .opacity(seen ? 1 : 0.38)
                            }
                            TextField("Note to the agent (optional)", text: $note, axis: .vertical)
                                .lineLimit(1...4)
                                .type(Tokens.Typography.body)
                                .padding(Tokens.Spacing.s3)
                                .background(RoundedRectangle(cornerRadius: Tokens.Radius.md).fill(Tokens.Colors.surface2.color))
                            OptionButton(label: "Deny", strong: false, amber: true, height: 48) { answer(p, allow: false, .once) }
                        }
                    } else {
                        Text(p.answer.map { $0 == "deny" ? "You denied it" : "You allowed it" } ?? (p.answeredAt != nil ? "Answered" : "Expired"))
                            .type(Tokens.Typography.body)
                            .foregroundStyle(Tokens.Colors.fg2.color)
                    }
                    SessionLine(source: p.body.source, agent: p.body.agent)
                }
                .padding(Tokens.Spacing.s5)
            }
            .foregroundStyle(Tokens.Colors.fg.color)
            .background(Tokens.Colors.bg.color.ignoresSafeArea())
        } else {
            Text("This prompt is gone.").type(Tokens.Typography.body).padding()
        }
    }

    private func answer(_ p: SavedPrompt, allow: Bool, _ scope: PermissionScope) {
        let message = allow ? nil : note
        close()
        Task { await store.answerPrompt(p.id, allow: allow, scope: scope, message: message) }
    }
}

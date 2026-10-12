import StarbridgeProtocol
import SwiftUI
import UIKit

/** What a sheet over the inbox shows. */
enum Sheet: Identifiable, Hashable {
    case decision(String)
    case prompt(String)
    /** A swiped question's snooze times, when the swipe asks for one (#692). */
    case snooze(String)

    var id: Self { self }
}

/**
 * The inbox, in the order every client uses (spec/clients.md): runs first, in their own section,
 * open until the owner closes it (#835), then permission prompts, then questions whose agent
 * waits, then the rest, each oldest first. Snoozed and History wait closed at the bottom.
 */
struct InboxView: View {
    let store: Store
    @State private var opened: Sheet?
    /** The Runs section, open by default and remembered on this iPhone (#835). */
    @AppStorage("runsOpen") private var runsOpen = true
    @State private var snoozedOpen = false
    @State private var historyOpen = false
    @State private var query = ""
    /** One feed, or grouped by machine or by waiting, remembered on this iPhone. */
    @AppStorage("grouping") private var grouping = Grouping.none
    /** Answer buttons on cards: Always, When the agent waits, or Never (#138). */
    @AppStorage("answerButtons") private var answerButtons = AnswerButtons.always
    /** What a swipe right on a question does (#692). */
    @AppStorage("swipeSnooze") private var swipe = SwipeSnooze.hour
    /** A swiped snooze that took, offering Undo for a few seconds. */
    @State private var undo: Swiped?
    /** The scanner, from the empty inbox of an account with no machine (#1370). */
    @State private var scanning = false
    /** Add a device, with the code the scanner read, if any. */
    @State private var adding: DevicesView.AddDevice?

    var body: some View {
        let decisions = store.openDecisions
        let runs = store.shownRuns
        let prompts: [FeedItem] = store.openPrompts.map { .prompt($0) }
        let waiting: [FeedItem] = decisions.filter { $0.waiting == "waiting" }.map { .decision($0) }
        let rest: [FeedItem] = decisions.filter { $0.waiting != "waiting" }.map { .decision($0) }
        let feed = prompts + waiting + rest
        let snoozed: [FeedItem] = store.snoozedDecisions.map { .decision($0) }
        let history = store.history
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: Tokens.Spacing.s2) {
                    if let notice = store.recoveryInfo?.notice { RecoveryBanner(store: store, notice: notice) }
                    if let why = store.withheldWhy { HeldBanner(store: store, why: why) }
                    if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                        found(runs.map { .run($0) } + feed + snoozed, history)
                    } else {
                        if !runs.isEmpty {
                            // Closed, its head still names failed and lost runs, so closing it never hides a failure.
                            Collapsible(title: "Runs", count: RunsHead.count(runs), symbol: "play.circle", open: $runsOpen, top: false, note: RunsHead.note(runs)) {
                                ForEach(runs, id: \.id) { card(.run($0)) }
                            }
                        }
                        ForEach(groups(feed), id: \.title) { group in
                            if let title = group.title.isEmpty ? nil : group.title {
                                GroupHeader(title: title, count: group.items.count, amber: group.amber)
                            }
                            ForEach(group.items) { card($0) }
                        }
                        if feed.isEmpty, runs.isEmpty, store.withheldWhy == nil {
                            if NoMachine.shows(store.devices) {
                                NoMachine(server: store.saved.server) {
                                    // A phone that cannot scan opens Add a device instead, to type the code.
                                    Task { if await QRScanner.whyNot(typing: true) == nil { scanning = true } else { adding = .init() } }
                                } addDevice: {
                                    adding = .init()
                                }
                            } else {
                                Text("Nothing needs you")
                                    .type(Tokens.Typography.heading)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, Tokens.Spacing.s16)
                            }
                        }
                        if !snoozed.isEmpty {
                            Collapsible(title: "Snoozed", count: "\(snoozed.count)", symbol: "moon.zzz", open: $snoozedOpen) {
                                ForEach(snoozed) { card($0) }
                            }
                        }
                        if !history.isEmpty {
                            Collapsible(title: "History", count: "", symbol: "clock.arrow.circlepath", open: $historyOpen) {
                                ForEach(history.prefix(100), id: \.id) { d in HistoryRow(decision: d, store: store) { opened = .decision(d.id) } }
                            }
                        }
                    }
                }
                .padding(.horizontal, Tokens.Spacing.s3)
                .padding(.bottom, Tokens.Spacing.s6)
                .animation(.default, value: decisions.map(\.id))
            }
            .refreshable { await store.refresh() }
            .background(Tokens.Colors.bg.color.ignoresSafeArea())
            .navigationTitle("Inbox")
            .navigationDestination(item: $adding) { AddDeviceView(store: store, lookUp: $0.lookUp) }
            .searchable(text: $query, prompt: "Find")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("View", selection: $grouping) {
                            ForEach(Grouping.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("Options")
                    }
                }
            }
        }
        .sheet(isPresented: $scanning) {
            QRScanner { text in
                scanning = false
                adding = .init(lookUp: text)
            }
            .ignoresSafeArea()
        }
        .sheet(item: $opened) { which in
            Group {
                switch which {
                case let .decision(id): DecisionDetail(store: store, id: id) { opened = nil }
                case let .prompt(id): PromptDetail(store: store, id: id) { opened = nil }
                case let .snooze(id): SnoozeSheet(store: store, id: id) { opened = nil }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .bottom) {
            if let undo {
                UndoBar(text: "Snoozed until \(Times.clock(undo.until, Date()))") {
                    self.undo = nil
                    Task { await store.snooze(undo.id, until: Date()) }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: undo) {
                    try? await Task.sleep(for: .seconds(4))
                    if self.undo == undo { withAnimation { self.undo = nil } }
                }
            }
        }
        .onChange(of: store.openRequest, initial: true) { _, request in
            guard let request else { return }
            opened = request
            store.openRequest = nil
        }
    }
}

extension InboxView {
    @ViewBuilder func card(_ item: FeedItem) -> some View {
        switch item {
        case let .run(r): RunCard(run: r, store: store)
        case let .prompt(p): PromptCard(prompt: p, store: store) { opened = .prompt(p.id) }
        case let .decision(d):
            let card = DecisionCard(decision: d, store: store, buttons: answerButtons) { opened = .decision(d.id) }
            if d.snoozed == nil { SwipeToSnooze { swiped(d.id) } content: { card } } else { card }
        }
    }

    /**
     * A swipe right snoozes for the time set in Settings, then offers Undo once the snooze took,
     * or opens the times over the inbox (#692). One that failed says why instead.
     */
    func swiped(_ id: String) {
        guard let until = swipe.until(Date()) else {
            opened = .snooze(id)
            return
        }
        Task {
            await store.snooze(id, until: until)
            if store.decision(id)?.snoozedUntil == Dates.format(until) { withAnimation { undo = Swiped(id: id, until: until) } }
        }
    }

    /**
     * "Group by machine" splits the feed under each machine; "Group by waiting" puts what blocks
     * an agent under "Waiting on you" and the rest under "When you can". Runs keep their section above.
     */
    func groups(_ feed: [FeedItem]) -> [FeedGroup] {
        switch grouping {
        case .none:
            return [FeedGroup(title: "", items: feed)]
        case .machine:
            var order: [String] = []
            var byMachine: [String: [FeedItem]] = [:]
            for item in feed {
                if byMachine[item.machine] == nil { order.append(item.machine) }
                byMachine[item.machine, default: []].append(item)
            }
            return order.map { FeedGroup(title: $0, items: byMachine[$0]!) }
        case .waiting:
            return [FeedGroup(title: "Waiting on you", items: feed.filter(\.waits), amber: true), FeedGroup(title: "When you can", items: feed.filter { !$0.waits })]
                .filter { !$0.items.isEmpty }
        }
    }

    /**
     * Find: every word in the machine, the repo, the agent's words, the session, and a History
     * item's answer. Open matches first, then History's.
     */
    @ViewBuilder func found(_ open: [FeedItem], _ history: [SavedDecision]) -> some View {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let matches = { (text: String) in let t = text.lowercased(); return words.allSatisfy { t.contains($0) } }
        let needs = open.filter { matches($0.searchText) }
        let past = history.filter { matches(FeedItem.decision($0).searchText + " " + HistoryText.how($0, store)) }
        if !needs.isEmpty {
            GroupHeader(title: "Needs you", count: needs.count, amber: true)
            ForEach(needs) { card($0) }
        }
        if !past.isEmpty {
            GroupHeader(title: "History", count: past.count, amber: false)
            ForEach(past, id: \.id) { d in HistoryRow(decision: d, store: store) { opened = .decision(d.id) } }
        }
        if needs.isEmpty, past.isEmpty {
            Text("Nothing matches").type(Tokens.Typography.heading).frame(maxWidth: .infinity).padding(.vertical, Tokens.Spacing.s16)
        }
    }
}

enum Grouping: String, CaseIterable {
    case none, machine, waiting

    var label: String {
        switch self {
        case .none: "One feed"
        case .machine: "Group by machine"
        case .waiting: "Group by waiting"
        }
    }
}

enum AnswerButtons: String, CaseIterable {
    case always, waiting, never

    var label: String {
        switch self {
        case .always: "Always"
        case .waiting: "When the agent waits"
        case .never: "Never"
        }
    }
}

/** One card of the feed. */
enum FeedItem: Identifiable {
    case run(SavedRun)
    case prompt(SavedPrompt)
    case decision(SavedDecision)

    var id: String {
        switch self {
        case let .run(r): "r/" + r.id
        case let .prompt(p): "p/" + p.id
        case let .decision(d): "d/" + d.id
        }
    }

    var source: Source {
        switch self {
        case let .run(r): r.body.source
        case let .prompt(p): p.body.source
        case let .decision(d): d.body.source
        }
    }

    var machine: String { source.machine }

    /** A prompt always blocks; a question when its agent says it waits. */
    var waits: Bool {
        switch self {
        case .run: false
        case .prompt: true
        case let .decision(d): d.waiting == "waiting"
        }
    }

    var searchText: String {
        let s = source
        let words: [String] = switch self {
        case let .run(r): [r.body.title, r.body.reason]
        case let .prompt(p): [p.headline, p.fullInput]
        case let .decision(d): [d.body.question, d.body.context]
        }
        return ([s.machine, s.project, s.sessionTitle ?? ""] + words).joined(separator: " ")
    }
}

struct FeedGroup {
    let title: String
    let items: [FeedItem]
    var amber = false
}

/** "Waiting on you 2": a group's name, its count in amber for what blocks an agent. */
private struct GroupHeader: View {
    let title: String
    let count: Int
    let amber: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.s2) {
            Text(title).type(Tokens.Typography.label)
            Text("\(count)").type(Tokens.Typography.machine).foregroundStyle(amber ? Tokens.Colors.accent.color : Tokens.Colors.fg2.color)
            Spacer()
        }
        .padding(.horizontal, Tokens.Spacing.s2)
        .padding(.top, Tokens.Spacing.s4)
        .accessibilityAddTraits(.isHeader)
    }
}

/** A closed group at the bottom: its header opens it (#662). */
private struct Collapsible<Content: View>: View {
    let title: String
    let count: String
    let symbol: String
    @Binding var open: Bool
    /** Spaced from what is above it; the Runs section starts the list. */
    var top = true
    /** Said after the count, such as the Runs head's failed and lost runs. */
    var note: Text?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: Tokens.Spacing.s2) {
            Button {
                withAnimation { open.toggle() }
            } label: {
                HStack(spacing: Tokens.Spacing.s2) {
                    Image(systemName: symbol)
                    Text(title).type(Tokens.Typography.label)
                    Text(count).type(Tokens.Typography.machine).foregroundStyle(Tokens.Colors.fg2.color)
                    if let note { note.type(Tokens.Typography.machine) }
                    Spacer()
                    Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 180 : 0))
                }
                .foregroundStyle(Tokens.Colors.fg.color)
                .frame(minHeight: Tokens.Sizes.tap)
                .padding(.horizontal, Tokens.Spacing.s2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { content }
        }
        .padding(.top, top ? Tokens.Spacing.s4 : 0)
    }
}

/** What the Runs head says besides its title: how many, and the failed ones in red, then the lost (#835). */
enum RunsHead {
    static func count(_ runs: [SavedRun]) -> String { "\(runs.count)" }

    static func words(_ runs: [SavedRun]) -> (failed: String?, lost: String?) {
        let failed = runs.filter(\.failed).count
        let lost = runs.filter(\.lost).count
        return (failed > 0 ? "· \(failed) failed" : nil, lost > 0 ? "· \(lost) lost" : nil)
    }

    static func note(_ runs: [SavedRun]) -> Text? {
        let (failed, lost) = words(runs)
        let parts = [failed.map { Text($0).foregroundStyle(Tokens.Colors.bad.color) }, lost.map { Text($0).foregroundStyle(Tokens.Colors.fg2.color) }].compactMap(\.self)
        return parts.isEmpty ? nil : parts.dropFirst().reduce(parts[0]) { Text("\($0) \($1)") }
    }
}

/** One filled card; amber fill is the only thing that says an agent waits (#248). */
private struct Card<Content: View>: View {
    let amber: Bool
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .padding(Tokens.Spacing.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Tokens.Radius.lg)
                    .fill(Tokens.Colors.surface.color)
                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(amber ? Tokens.Colors.accentSoft.color : .clear))
            )
    }
}

private struct DecisionCard: View {
    let decision: SavedDecision
    let store: Store
    var buttons = AnswerButtons.always
    let open: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date
            // Snoozed, nothing is amber, even when its agent waits: the owner said not now (#571).
            let until = decision.snoozed
            let waiting = decision.waiting == "waiting" && until == nil
            let since = waiting ? decision.waitingAt.flatMap(Dates.parse) : nil
            let slot = until.map { "Until \(Times.clock($0, now))" }
                ?? since.map { Times.waited($0, now) }
                ?? Dates.parse(decision.body.createdAt).map { Times.since($0, now) } ?? ""
            Card(amber: waiting) {
                MetaRow(source: decision.body.source, time: slot, clock: waiting)
                HStack(alignment: .top, spacing: Tokens.Spacing.s2) {
                    Image(systemName: "questionmark.circle")
                        .foregroundStyle(waiting ? Tokens.Colors.accent.color : Tokens.Colors.fg2.color)
                        .accessibilityHidden(true)
                    // A long press copies it; a tap still opens the question (#1143).
                    Text(decision.body.question)
                        .type(Tokens.Typography.subtitle)
                        .fontWeight(waiting ? .medium : .regular)
                        .textSelection(.enabled)
                }
                if let why = store.notSent[decision.id] {
                    Text("Not sent: \(why)").type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.bad.color)
                }
                if !decision.images.isEmpty {
                    ImageRows(images: decision.images, maxHeight: 160) { _ in open() }
                        .padding(.vertical, Tokens.Spacing.s1)
                }
                // A snoozed card stays quiet: the owner opens it to answer.
                if until == nil, !decision.body.options.isEmpty, buttons == .always || (buttons == .waiting && waiting) {
                    Options(decision: decision.body, amber: waiting, height: 40) { store.answer(decision.id, choice: $0, text: nil) }
                        .padding(.top, Tokens.Spacing.s1)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .accessibilityElement(children: .contain)
            .accessibilityValue(waiting ? since.map { Times.waitingLabel($0, now) } ?? "Waiting for you" : until.map { "Snoozed until \(Times.clock($0, now))" } ?? "")
            .accessibilityAction(named: "Open the question", open)
        }
    }
}

/** An answered question: what was answered, and how; "not sent yet" until the server takes it. */
private struct HistoryRow: View {
    let decision: SavedDecision
    let store: Store
    let open: () -> Void

    var body: some View {
        Card(amber: false) {
            MetaRow(source: decision.body.source, time: decision.answeredAt.flatMap(Dates.parse).map { Times.since($0, Date()) } ?? "")
            Text(decision.body.question).type(Tokens.Typography.body).lineLimit(2)
            Text(HistoryText.how(decision, store)).type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color).lineLimit(2)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
    }
}

private struct PromptCard: View {
    let prompt: SavedPrompt
    let store: Store
    let open: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Card(amber: true) {
                MetaRow(source: prompt.body.source, time: Dates.parse(prompt.body.createdAt).map { Times.waited($0, context.date) } ?? "", clock: true)
                HStack(alignment: .top, spacing: Tokens.Spacing.s2) {
                    Image(systemName: "terminal").foregroundStyle(Tokens.Colors.accent.color).accessibilityHidden(true)
                    Text(prompt.headline).type(Tokens.Typography.action)
                }
                // The whole input when it fits a line, else the summary; Allow covers only what shows (#356).
                Text(prompt.fitsRow ? prompt.fullInput : visible(prompt.body.summary))
                    .type(Tokens.Typography.code)
                    .lineLimit(prompt.fitsRow ? nil : 3)
                    .padding(Tokens.Spacing.s3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.md).fill(Tokens.Colors.surface.color))
                HStack(spacing: Tokens.Spacing.s2) {
                    OptionButton(label: "Deny", strong: false, amber: true, height: 40) { Task { await store.answerPrompt(prompt.id, allow: false) } }
                    OptionButton(label: "Allow", strong: true, amber: true, height: 40) {
                        if prompt.fitsRow { Task { await store.answerPrompt(prompt.id, allow: true) } } else { open() }
                    }
                }
                .padding(.top, Tokens.Spacing.s1)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: "Open the prompt", open)
        }
    }
}

/** A `starbridge run`: running with its progress, passed, failed, or lost; ended ones can go. */
private struct RunCard: View {
    let run: SavedRun
    let store: Store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date
            let started = Dates.parse(run.body.startedAt) ?? now
            let state: (String, Color) = if let exit = run.body.exit {
                exit.code == 0 ? ("Passed", Tokens.Colors.ok.color) : ("Failed, exit \(exit.code)", Tokens.Colors.bad.color)
            } else if run.lost {
                ("Lost, no news for \(Times.elapsed(run.lastNews, now))", Tokens.Colors.fg3.color)
            } else {
                ("Running, \(Times.elapsed(started, now))", Tokens.Colors.fg2.color)
            }
            Card(amber: false) {
                MetaRow(source: run.body.source, time: Times.since(started, now))
                HStack(alignment: .top, spacing: Tokens.Spacing.s2) {
                    Image(systemName: "terminal").foregroundStyle(Tokens.Colors.fg2.color).accessibilityHidden(true)
                    Text(run.body.title).type(Tokens.Typography.subtitle).fontWeight(.regular)
                }
                Text(run.body.reason).type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color)
                if let p = run.body.progress, run.body.exit == nil, p.total > 0 {
                    ProgressView(value: Double(p.done), total: Double(p.total))
                        .tint(Tokens.Colors.fg.color)
                        .accessibilityValue(p.unit == "percent" ? "\(p.done) percent" : "\(p.done) of \(p.total)")
                }
                HStack {
                    Text(state.0).type(Tokens.Typography.small).foregroundStyle(state.1)
                    Spacer()
                    if run.body.exit != nil || run.lost {
                        Button("Dismiss") { store.dismissRun(run.id) }
                            .type(Tokens.Typography.action)
                            .foregroundStyle(Tokens.Colors.fg.color)
                            .frame(minHeight: Tokens.Sizes.tap)
                    }
                }
            }
        }
    }
}

/** A replacement of the recovery key made on another device (#348), said once. */
private struct RecoveryBanner: View {
    let store: Store
    let notice: RecoveryNotice

    var body: some View {
        HStack(spacing: Tokens.Spacing.s2) {
            Text("Recovery key replaced on \(notice.by), \(notice.at.formatted(.dateTime.month(.abbreviated).day())), \(notice.at.formatted(date: .omitted, time: .shortened)).")
                .type(Tokens.Typography.body)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("OK") { store.dismissRecoveryNotice(notice.seq) }
                .type(Tokens.Typography.label)
                .frame(minWidth: Tokens.Sizes.tap, minHeight: Tokens.Sizes.tap)
        }
        .padding(.leading, Tokens.Spacing.s4)
        .padding(.vertical, Tokens.Spacing.s2)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.surface2.color))
    }
}

/** Nothing from the machines shows: the server holds back entries a machine has seen (#362). */
private struct HeldBanner: View {
    let store: Store
    let why: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s2) {
            Text(why).type(Tokens.Typography.small)
            if store.heldRevoked != nil {
                Button("Stop waiting") { Task { await store.stopWaiting() } }.type(Tokens.Typography.action)
            }
        }
        .padding(Tokens.Spacing.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.badSoft.color))
    }
}

struct Swiped: Equatable {
    let id: String
    let until: Date
}

/** How far a card goes before letting go snoozes it (#692): 40% of its width. */
private let swipeArms: CGFloat = 0.4

/**
 * A question's card that snoozes on a swipe right (#692), as Android's: past 40% of its width the
 * panel behind it darkens, its icon fills and the phone ticks; let go there and it snoozes, while
 * the card slides back. Let go earlier and nothing happens. VoiceOver gets a Snooze action.
 */
private struct SwipeToSnooze<Content: View>: View {
    let onSwipe: () -> Void
    @ViewBuilder let content: Content
    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 0
    /** The drag's direction, settled by its first move: only a sideways one moves the card. */
    @State private var sideways: Bool?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let armed = width > 0 && offset >= width * swipeArms
        content
            .offset(x: offset)
            .background(alignment: .leading) {
                // Only while it moves: at rest the panel would show at the card's rounded edges.
                if offset > 0 {
                    HStack(spacing: Tokens.Spacing.s2) {
                        Image(systemName: armed ? "moon.zzz.fill" : "moon.zzz")
                        Text("Snooze").type(Tokens.Typography.label)
                    }
                    .foregroundStyle(armed ? Tokens.Colors.fg.color : Tokens.Colors.fg2.color)
                    .padding(.horizontal, Tokens.Spacing.s5)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(armed ? Tokens.Colors.lineStrong.color : Tokens.Colors.surface2.color))
                    .accessibilityHidden(true)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .simultaneousGesture(
                DragGesture(minimumDistance: 16)
                    .onChanged { g in
                        if sideways == nil { sideways = abs(g.translation.width) > abs(g.translation.height) }
                        guard sideways == true else { return }
                        offset = max(0, g.translation.width)
                    }
                    .onEnded { _ in
                        let snooze = sideways == true && width > 0 && offset >= width * swipeArms
                        sideways = nil
                        withAnimation(.spring(duration: 0.3)) { offset = 0 }
                        if snooze { onSwipe() }
                    }
            )
            // Ticks crossing 40%, and again backing under it, but not as the card springs back after a snooze.
            .sensoryFeedback(trigger: armed) { _, now in now || sideways != nil ? .impact(weight: .light) : nil }
            .accessibilityAction(named: "Snooze", onSwipe)
            // A drag cut short, by a call or the app leaving, never ends: the card goes back.
            .onChange(of: scenePhase) {
                sideways = nil
                offset = 0
            }
    }
}

/** The times over the inbox, for a swiped card (#692): what the agent asked, then the times. */
private struct SnoozeSheet: View {
    let store: Store
    let id: String
    let close: () -> Void

    var body: some View {
        let open = store.decision(id)?.isOpen == true
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
                if let d = store.decision(id), open {
                    Text(d.body.question).type(Tokens.Typography.subtitle)
                    SnoozeControls(store: store, id: id, until: nil, open: true, done: close)
                } else {
                    Text("This question is gone.").type(Tokens.Typography.body)
                }
            }
            .padding(Tokens.Spacing.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        // Answered meanwhile, on this iPhone or another: nothing left to put off.
        .onChange(of: open) { if !open { close() } }
    }
}

/** A line at the bottom with one action, as Android's snackbar. */
private struct UndoBar: View {
    let text: String
    let action: () -> Void

    var body: some View {
        HStack {
            Text(text).type(Tokens.Typography.body)
            Spacer()
            Button("Undo", action: action)
                .font(.system(size: Tokens.Typography.action.size, weight: .medium))
                .frame(minHeight: Tokens.Sizes.tap)
        }
        .foregroundStyle(Tokens.Colors.bg.color)
        .tint(Tokens.Colors.bg.color)
        .padding(.horizontal, Tokens.Spacing.s4)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.md).fill(Tokens.Colors.fg.color))
        .padding(.horizontal, Tokens.Spacing.s3)
        .padding(.bottom, Tokens.Spacing.s2)
    }
}

/**
 * A new account's empty inbox, as on Android and the web (#610, #1370): the install command to
 * copy or send to the machine, then the scanner for the QR code its setup shows, one tap away.
 */
struct NoMachine: View {
    let server: String
    let scan: () -> Void
    let addDevice: () -> Void

    /** While the directory has been read and holds no machine. */
    static func shows(_ rows: [DeviceRow]) -> Bool { !rows.isEmpty && !rows.contains(where: \.machine) }

    /** The server's own install script, which pairs with it (#1378). */
    static func install(_ server: String) -> String {
        "curl -fsSL \(server.hasSuffix("/") ? String(server.dropLast()) : server)/install.sh | sh"
    }

    var body: some View {
        let install = Self.install(server)
        VStack(spacing: Tokens.Spacing.s4) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 52))
                .frame(width: 140, height: 140)
                .background(Circle().fill(Tokens.Colors.surface2.color))
                .accessibilityHidden(true)
            Text("Add a machine")
                .type(Tokens.Typography.heading)
                .accessibilityAddTraits(.isHeader)
            Text("Install Starbridge on each machine that runs your agents, then scan the QR code from your terminal.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
                .multilineTextAlignment(.center)
            Text(install)
                .type(Tokens.Typography.code)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Tokens.Spacing.s4)
                .background(RoundedRectangle(cornerRadius: Tokens.Radius.lg).fill(Tokens.Colors.surface2.color))
            HStack(spacing: Tokens.Spacing.s2) {
                Button {
                    UIPasteboard.general.string = install
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(Secondary())
                // To the computer, by mail or a chat, when this iPhone is not where the terminal is.
                ShareLink(item: install) { Text("Send") }
                    .buttonStyle(Secondary())
            }
            Button(action: scan) {
                Label("Scan a QR code", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(Primary())
            Button("Other ways to add a device", action: addDevice)
                .type(Tokens.Typography.action)
                .frame(minHeight: Tokens.Sizes.tap)
            Link("Windows, Homebrew and npm", destination: URL(string: "https://starbridge.run/docs")!)
                .type(Tokens.Typography.action)
                .frame(minHeight: Tokens.Sizes.tap)
        }
        .foregroundStyle(Tokens.Colors.fg.color)
        .padding(.top, Tokens.Spacing.s12)
        .padding(.bottom, Tokens.Spacing.s8)
        .padding(.horizontal, Tokens.Spacing.s2)
    }
}

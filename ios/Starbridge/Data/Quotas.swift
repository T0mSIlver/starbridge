import Foundation
import StarbridgeProtocol

/** Where a window is headed by its reset, as the uploader computed it. */
enum QuotaPace: Equatable {
    case even
    case runsOut(Date)
    case unused(Int)
    /** Too early in the window to tell. */
    case unknown

    /** The card's state follows a pace alert; "low" only notifies. */
    init(_ pace: Pace?, unusedAlert: Double?) {
        if let pace, pace.stage != "unknown" {
            if !pace.willLastToReset {
                self = pace.runsOutAt.flatMap(Dates.parse).map(QuotaPace.runsOut) ?? .unknown
            } else if let unusedAlert {
                self = .unused(Int(unusedAlert.rounded()))
            } else {
                self = .even
            }
        } else {
            self = .unknown
        }
    }
}

/** One quota window of one AI plan, as the Quotas tab shows it. */
struct QuotaRow: Identifiable, Equatable {
    /** The machine, the provider and the uploader's window id. */
    let id: String
    let provider: String
    /** The window's name: CodexBar's label, else its id. */
    let window: String
    /** The uploader's id for the window, such as `secondary`, which keys its alerts (#914). */
    let windowId: String
    let usedPercent: Int
    let resetsAt: Date?
    let pace: QuotaPace
    /** Where a steady pace would be now, in percent used, when the uploader knows. */
    let steadyPercent: Int?
    /** The uploading machine's name, set when more than one machine uploads quotas. */
    let machine: String?
    let windowMinutes: Int?
    /** When the uploader read this window: its snapshot's time, or earlier when it is stale. */
    let takenAt: Date?
    /** Why CodexBar failed for the provider; the window is then the last one it read (#397). */
    let error: String?

    /** The window reset after this snapshot: its use and pace belong to the window that ended. */
    func ended(_ now: Date) -> Bool { resetsAt.map { $0 <= now } ?? false }

    func course(_ now: Date) -> Course {
        guard case let .runsOut(at) = pace, !ended(now) else { return .steady }
        return at > now ? .willRunOut : .ranOut
    }

    /** Will run out, or ran out, and has not reset: what "Running out first" moves up. */
    func runningOut(_ now: Date) -> Bool {
        if case .runsOut = pace { return resetsAt.map { $0 > now } ?? true }
        return false
    }
}

/** Where a window is headed, as its meter draws it. */
enum Course { case steady, willRunOut, ranOut }

/** A provider CodexBar failed for with no windows to keep: its card says only why (#450). */
struct QuotaFailure: Equatable {
    let provider: String
    let error: String
    let machine: String?

    /** Two machines can fail the same provider. */
    var key: String { provider + "/" + (machine ?? "") }
}

/**
 * Quota settings, on this iPhone (spec/items.md, "Quota settings follow CodexBar"): a curated
 * set of CodexBar's own settings with CodexBar's meaning, as Android's QuotaSettings.
 */
struct QuotaSettings: Codable, Equatable {
    /** The bar and the percentage show used, else remaining (CodexBar `usageBarsShowUsed`). */
    var showUsed = true
    /** Reset times as a clock time, else "in 2 h" (`resetTimesShowAbsolute`). */
    var absoluteResets = false
    /** Workdays a week on weekly bars, from Monday (`weeklyProgressWorkDays`); nil is off. */
    var workDays: Int?
    /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
    var order: [String] = []
    /** Windows that will run out or ran out lead, else `order` holds for every window. */
    var runningOutFirst = true
    var hidden: [String] = []

    static let week = 10080

    init() {}

    /** A field a newer release added reads as its default. */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showUsed = try c.decodeIfPresent(Bool.self, forKey: .showUsed) ?? true
        absoluteResets = try c.decodeIfPresent(Bool.self, forKey: .absoluteResets) ?? false
        workDays = try c.decodeIfPresent(Int.self, forKey: .workDays)
        order = try c.decodeIfPresent([String].self, forKey: .order) ?? []
        runningOutFirst = try c.decodeIfPresent(Bool.self, forKey: .runningOutFirst) ?? true
        hidden = try c.decodeIfPresent([String].self, forKey: .hidden) ?? []
    }

    /** Every provider the windows name, in this order. */
    func providers(_ windows: [QuotaRow]) -> [String] {
        var seen: [String] = []
        for w in windows where !seen.contains(w.provider) { seen.append(w.provider) }
        let known = order.filter(seen.contains)
        return known + seen.filter { !known.contains($0) }
    }

    /**
     * The windows to show (spec/items.md, "Quota order"): hidden providers out, the rest by
     * provider in this order, each provider's windows in the uploader's order. With
     * `runningOutFirst`, windows that will run out or ran out, and have not reset, lead.
     */
    func arrange(_ windows: [QuotaRow], _ now: Date) -> [QuotaRow] {
        let rank = Dictionary(providers(windows).enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let ordered = windows.enumerated()
            .filter { !hidden.contains($0.element.provider) }
            .sorted { (rank[$0.element.provider]!, $0.offset) < (rank[$1.element.provider]!, $1.offset) }
            .map(\.element)
        guard runningOutFirst else { return ordered }
        return ordered.filter { $0.runningOut(now) } + ordered.filter { !$0.runningOut(now) }
    }

    /** Arranged windows under one heading per provider and machine (#160), in the order of their first window. */
    func groups(_ arranged: [QuotaRow]) -> [[QuotaRow]] {
        var keys: [String] = []
        var byKey: [String: [QuotaRow]] = [:]
        for w in arranged {
            let key = w.provider + "\u{0}" + (w.machine ?? "")
            if byKey[key] == nil { keys.append(key) }
            byKey[key, default: []].append(w)
        }
        return keys.map { byKey[$0]! }
    }

    /** CodexBar's workday ticks: one per workday boundary, evenly spaced along a weekly bar. */
    func ticks(_ window: QuotaRow) -> [Double] {
        guard let days = workDays, window.windowMinutes == Self.week else { return [] }
        return (1..<max(days, 1)).map { Double($0) / Double(days) }
    }

    /** What a card's bar shows: its percentage, fill and pace marker, all on the same scale. */
    func bar(_ window: QuotaRow, _ now: Date, _ calendar: Calendar = .current) -> Bar {
        let used = min(max(window.usedPercent, 0), 100)
        let steady = Self.workdayExpected(window, workDays, now, calendar).map { Int($0.rounded()) } ?? window.steadyPercent
        return Bar(
            percent: showUsed ? used : 100 - used,
            word: showUsed ? "used" : "left",
            steady: steady.map { showUsed ? $0 : 100 - $0 },
            ticks: ticks(window)
        )
    }

    struct Bar: Equatable {
        let percent: Int
        let word: String
        let steady: Int?
        let ticks: [Double]
    }

    /**
     * Where an even pace over workdays only would be now, in percent used, as CodexBar's
     * `UsagePace.weekly`: the week splits at local midnights, and Monday to the `workDays`-th day
     * count. Nil when it does not apply: no setting, 7 days, or not weekly.
     */
    static func workdayExpected(_ window: QuotaRow, _ workDays: Int?, _ now: Date, _ calendar: Calendar = .current) -> Double? {
        guard let end = window.resetsAt, let workDays, workDays < 7, window.windowMinutes == week else { return nil }
        var cursor = end.addingTimeInterval(-Double(week) * 60)
        var total: TimeInterval = 0
        var elapsed: TimeInterval = 0
        while cursor < end {
            let next = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: cursor))!
            let sliceEnd = min(next, end)
            // Monday is 1, as java.time's DayOfWeek counts.
            let weekday = (calendar.component(.weekday, from: cursor) + 5) % 7 + 1
            if weekday <= workDays {
                total += sliceEnd.timeIntervalSince(cursor)
                if now > cursor { elapsed += min(now, sliceEnd).timeIntervalSince(cursor) }
            }
            cursor = sliceEnd
        }
        return total > 0 ? min(max(elapsed * 100 / total, 0), 100) : nil
    }

    // --- Stored on this iPhone ------------------------------------------------------

    static let key = "quotaSettings"

    static func load(_ defaults: UserDefaults = .standard) -> QuotaSettings {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(QuotaSettings.self, from: $0) } ?? QuotaSettings()
    }

    func store(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }
}

/** How long a pull on Quotas waits for the machines' fresh snapshots. */
private let quotaAskSeconds = 25

extension Store {
    /** Whether the account has more than one active machine, which names each window's. */
    private var namesMachines: Bool { (directory?.active(.machine).count ?? 0) > 1 }

    private var activeQuotas: [SavedQuota] {
        if withheldWhy != nil { return [] }
        return saved.quotas.filter { directory?.members[$0.from]?.active != false }
    }

    /** Every window of every active machine's snapshot, in the uploader's order. */
    var quotaWindows: [QuotaRow] {
        let named = namesMachines
        return activeQuotas.flatMap { q in
            q.body.providers.flatMap { p in
                p.windows.map { w in
                    let unused = q.body.alerts.first { a in
                        if case .unusedHeadroom = a.kind { return a.provider == p.provider && a.window == w.id }
                        return false
                    }
                    var unusedPercent: Double?
                    if case let .unusedHeadroom(percent)? = unused?.kind { unusedPercent = percent }
                    return QuotaRow(
                        id: "\(q.from)/\(p.provider)/\(w.id)",
                        provider: p.provider,
                        window: w.label.isEmpty ? w.id : w.label,
                        windowId: w.id,
                        usedPercent: Int(w.usedPercent.rounded()),
                        resetsAt: w.resetsAt.flatMap(Dates.parse),
                        pace: QuotaPace(w.pace, unusedAlert: unusedPercent),
                        steadyPercent: w.pace.map { min(max(Int($0.expectedUsedPercent.rounded()), 0), 100) },
                        machine: named ? memberName(q.from) : nil,
                        windowMinutes: w.windowMinutes,
                        takenAt: Dates.parse(p.updatedAt ?? q.body.takenAt),
                        error: p.error
                    )
                }
            }
        }
    }

    /** Providers CodexBar failed for, with no windows to keep. */
    var quotaFailures: [QuotaFailure] {
        let named = namesMachines
        return activeQuotas.flatMap { q in
            q.body.providers.compactMap { p in
                guard let error = p.error, p.windows.isEmpty else { return nil }
                return QuotaFailure(provider: p.provider, error: error, machine: named ? memberName(q.from) : nil)
            }
        }
    }

    /** A machine of the account sends quotas (#914): until then the tab and its settings stay out of the way. */
    var quotasHeld: Bool { quotasListed || !saved.quotas.isEmpty }

    /** The account's machines by name; nil until the directory has loaded. */
    var machineNames: [String]? {
        guard let dir = directory else { return nil }
        var names: [String] = []
        for m in dir.active(.machine) where !names.contains(m.name) { names.append(m.name) }
        return names
    }

    /**
     * The latest snapshot from each machine. APNs carries none (PROTOCOL.md, "Push"), so the app
     * reads them as it reads items. One this iPhone cannot open keeps that machine's last good one.
     */
    func syncQuotas() async throws {
        let listed = try await api().quota()
        quotasListed = !listed.isEmpty
        if try await scan(listed.map(\.item)) { return }
        let entries = saved.entries.compactMap { try? JSON.parse($0) }
        let quotas = listed.compactMap { l in
            open(l.item, entries: entries).flatMap { try? SavedQuota(from: $0.from, text: $0.text) }
                ?? saved.quotas.first { $0.from == l.item.from }
        }
        var s = saved
        s.quotas = quotas
        persist(s)
    }

    /** Asks the machines for fresh snapshots, waits for them, then syncs. */
    func refreshQuotas() async {
        quotasAsking = true
        defer { quotasAsking = false }
        // Asked too often, a server without asks, or offline: the sync shows what it holds.
        if phase == .ready { try? await api().askQuota(wait: quotaAskSeconds) }
        await refresh()
    }
}

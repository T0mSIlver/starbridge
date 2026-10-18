// Quota alert settings, which stay on the device, and how the Quotas tab reads a window. The
// local agent computes pace and alerts (packages/protocol), so this port has none (#1147).

import Foundation

/** What a device notifies about, per window (#914); the settings stay on the device. */
public struct QuotaAlertSettings: Equatable, Sendable {
    public static let choices = ["runs-out", "low-50", "low-20", "unused-headroom"]
    /** Each choice's name, as the alerts table heads its column, in order. */
    public static let labels = [("runs-out", "Runs out"), ("low-50", "50% left"), ("low-20", "20% left"), ("unused-headroom", "Unused")]

    /** Windows of a day or less. */
    public var short: [String]
    /** Longer windows, and those of unknown length. */
    public var long: [String]
    /**
     * A window's own choices, by `provider/window`, where an empty list is off. A key with no
     * window covers every window of its provider that has no key of its own; only settings moved
     * from before #914, by releases up to 0.1.8, hold one.
     */
    public var windows: [String: [String]]

    public init(short: [String] = [], long: [String] = ["runs-out"], windows: [String: [String]] = [:]) {
        self.short = short
        self.long = long
        self.windows = windows
    }

    /** A 5-hour window that runs out resets within hours; a weekly one costs days. */
    public static let defaults = QuotaAlertSettings()

    public static func windowKey(provider: String, window: String) -> String { "\(provider)/\(window)" }

    /** A window of a day or less. */
    public static func isShort(_ minutes: Int?) -> Bool { minutes.map { $0 <= 24 * 60 } ?? false }

    /** What a window notifies about: its own choices, else its provider's, else its length's. */
    public func choices(provider: String, window: String, minutes: Int?) -> [String] {
        windows[Self.windowKey(provider: provider, window: window)] ?? windows[provider] ?? (Self.isShort(minutes) ? short : long)
    }

    /**
     * Whether an alert notifies. Only the lowest level reached is raised, so a window that skips
     * past a level picked still notifies at the next one down.
     */
    public func wants(provider: String, window: String, kind: String, threshold: Int?, minutes: Int?) -> Bool {
        let picked = choices(provider: provider, window: window, minutes: minutes)
        if kind != "low" { return picked.contains(kind) }
        let t = threshold ?? 0
        return picked.contains { $0.hasPrefix("low-") && Int($0.dropFirst(4)).map { $0 >= t } == true }
    }
}

extension QuotaAlertSettings {
    /**
     * The settings with a window's own choices, or with none (nil) to follow its length's. A
     * provider's key first becomes a key per window of `all`, so the provider's other windows keep it.
     */
    public func with(provider: String, window: String, all: [(String, String)], picked: [String]?) -> QuotaAlertSettings {
        var next = self
        if let shared = next.windows.removeValue(forKey: provider) {
            for (p, w) in all where p == provider {
                let key = Self.windowKey(provider: p, window: w)
                if next.windows[key] == nil { next.windows[key] = shared }
            }
        }
        next.windows[Self.windowKey(provider: provider, window: window)] = picked
        return next
    }
}

// How the Quotas tab reads a window (#1904): packages/protocol/src/quotas.ts, checked against
// quotas.json. The app formats the times the words are about.

/** Where a window is headed by its reset: `unused` only when the uploader raised an unused-headroom alert. */
public enum QuotaCourse: String, Sendable {
    case unknown, runsOut = "runs-out", unused, even

    public init(_ pace: Pace?, unusedAlert: Bool) {
        guard let pace, pace.stage != "unknown" else { self = .unknown; return }
        if !pace.willLastToReset { self = pace.runsOutAt == nil ? .unknown : .runsOut }
        else { self = unusedAlert ? .unused : .even }
    }
}

/** What the state word says, and `word` its words; "Ran out" and "Will run out" go on with when. */
public enum QuotaState: String, CaseIterable, Sendable {
    case reset, unknown, ranOut = "ran-out", out, unused, ok

    public var word: String {
        switch self {
        case .reset: "Window reset"
        case .unknown: "Too early to tell"
        case .ranOut: "Ran out"
        case .out: "Will run out"
        case .unused: "Headroom unused"
        case .ok: "On pace"
        }
    }

    public init(_ course: QuotaCourse, runsOutAt: Date?, resetsAt: Date?, now: Date) {
        if quotaEnded(resetsAt, now) { self = .reset; return }
        switch course {
        case .unknown: self = .unknown
        case .runsOut: self = runsOutAt.map { $0 <= now } == true ? .ranOut : .out
        case .unused: self = .unused
        case .even: self = .ok
        }
    }
}

/** The reset passed: the window's use and pace belong to the cycle that ended. */
private func quotaEnded(_ resetsAt: Date?, _ now: Date) -> Bool { resetsAt.map { $0 <= now } ?? false }

/** Will run out or ran out, and has not reset: what "Running out first" moves up. */
public func quotaRunningOut(_ course: QuotaCourse, resetsAt: Date?, now: Date) -> Bool {
    course == .runsOut && !quotaEnded(resetsAt, now)
}

/** Every provider the windows name, in `order`; the ones not listed follow in the uploader's order. */
public func quotaProviders(_ providers: [String], order: [String]) -> [String] {
    var seen: [String] = []
    for p in providers where !seen.contains(p) { seen.append(p) }
    let known = order.filter(seen.contains)
    return known + seen.filter { !known.contains($0) }
}

/**
 * The windows to show (spec/items.md, "Quota order"): `hidden` providers out, the rest by provider
 * in `order`, a provider's machines by name, each machine's windows in the uploader's order. With
 * `runningOutFirst`, windows that will run out or ran out, and have not reset, lead in that same
 * order.
 */
public func arrangeQuotas<T>(
    _ windows: [T], order: [String], hidden: [String], runningOutFirst: Bool,
    provider: (T) -> String, machine: (T) -> String?, runningOut: (T) -> Bool,
    names: (String, String) -> ComparisonResult
) -> [T] {
    let providers = windows.map(provider)
    let machines = windows.map { machine($0) ?? "" }
    let leads = windows.map { runningOutFirst && runningOut($0) ? 0 : 1 }
    let rank = Dictionary(quotaProviders(providers, order: order).enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    return windows.indices
        .filter { !hidden.contains(providers[$0]) }
        .sorted { a, b in
            if leads[a] != leads[b] { return leads[a] < leads[b] }
            let (ra, rb) = (rank[providers[a]]!, rank[providers[b]]!)
            if ra != rb { return ra < rb }
            let byName = names(machines[a], machines[b])
            return byName == .orderedSame ? a < b : byName == .orderedAscending
        }
        .map { windows[$0] }
}

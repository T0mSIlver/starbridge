// Quota alert settings, which stay on the device. The local agent computes pace and alerts
// (packages/protocol), so this port has none (#1147).

/** What a device notifies about, per window (#914); the settings stay on the device. */
public struct QuotaAlertSettings: Equatable, Sendable {
    public static let choices = ["runs-out", "low-50", "low-20", "unused-headroom"]

    /** Windows of a day or less. */
    public var short: [String]
    /** Longer windows, and those of unknown length. */
    public var long: [String]
    /**
     * A window's own choices, by `provider/window`, where an empty list is off. A key with no
     * window covers every window of its provider that has no key of its own.
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

    /**
     * Settings from before #914: a bell per provider, and two switches for every provider whose
     * bell was on. Each provider with its bell on keeps what the switches let through.
     */
    public static func migrate(notify: [String], notifyLow: Bool = true, notifyPace: Bool = true) -> QuotaAlertSettings {
        let kept = (notifyPace ? ["runs-out"] : []) + (notifyLow ? ["low-50", "low-20"] : []) + (notifyPace ? ["unused-headroom"] : [])
        return QuotaAlertSettings(windows: Dictionary(notify.map { ($0, kept) }, uniquingKeysWith: { _, b in b }))
    }
}

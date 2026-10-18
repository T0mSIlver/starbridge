package dev.starbridge.app.data

import kotlinx.serialization.Serializable

/**
 * Which quota alerts this phone notifies about, per window (#914): the Kotlin side of
 * packages/protocol/src/quotaAlerts.ts, checked against quota-alerts.json. The uploader raises
 * every alert at fixed levels, so each device filters them by these settings.
 */
@Serializable
data class QuotaAlerts(
    /** Windows of a day or less. */
    val short: List<String> = emptyList(),
    /** Longer windows, and those of unknown length. */
    val long: List<String> = listOf(RUNS_OUT),
    /**
     * A window's own choices, by `provider/window`, where an empty list is off. A key with no
     * window covers every window of its provider that has no key of its own; only settings moved
     * from before #914, by releases up to 0.1.8, hold one.
     */
    val windows: Map<String, List<String>> = emptyMap(),
) {
    /** What a window notifies about: its own choices, else its provider's, else its length's. */
    fun choices(provider: String, window: String, minutes: Int?): List<String> =
        windows[key(provider, window)] ?: windows[provider] ?: if (isShort(minutes)) short else long

    /** A window's own choices, else null when it follows its length's. */
    fun own(provider: String, window: String): List<String>? = windows[key(provider, window)] ?: windows[provider]

    /**
     * Whether an alert notifies. `alertsFor` raises only the lowest level reached, so a window that
     * skips past a level picked still notifies at the next one down.
     */
    fun wants(provider: String, window: String, kind: String, threshold: Int?, minutes: Int?): Boolean {
        val picked = choices(provider, window, minutes)
        if (kind != "low") return kind in picked
        return picked.any { it.startsWith("low-") && (it.removePrefix("low-").toIntOrNull() ?: 0) >= (threshold ?: 0) }
    }

    /** Whether any window can notify. */
    val any get() = short.isNotEmpty() || long.isNotEmpty() || windows.values.any { it.isNotEmpty() }

    /**
     * A window's own choices, or null to follow its length's. A provider's key first becomes a key
     * per window of [all], so the provider's other windows keep it.
     */
    fun with(provider: String, window: String, all: List<Pair<String, String>>, picked: List<String>?): QuotaAlerts {
        val next = windows.toMutableMap()
        next.remove(provider)?.let { shared -> all.filter { it.first == provider }.forEach { (p, w) -> next.putIfAbsent(key(p, w), shared) } }
        if (picked != null) next[key(provider, window)] = picked else next.remove(key(provider, window))
        return copy(windows = next)
    }

    companion object {
        const val RUNS_OUT = "runs-out"
        /** The choices and their names, in the alerts table's column order (QUOTA_ALERT_LABELS). */
        val LABELS = listOf(RUNS_OUT to "Runs out", "low-50" to "50% left", "low-20" to "20% left", "unused-headroom" to "Unused")
        val CHOICES = LABELS.map { it.first }

        fun key(provider: String, window: String) = "$provider/$window"

        /** A window of a day or less, as `alertsFor` tells them apart. */
        fun isShort(minutes: Int?) = minutes != null && minutes <= 24 * 60
    }
}

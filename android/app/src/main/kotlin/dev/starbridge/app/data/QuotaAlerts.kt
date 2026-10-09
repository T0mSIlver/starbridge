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
     * window covers every window of its provider that has no key of its own; only settings from
     * before #914 write one.
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
        val CHOICES = listOf(RUNS_OUT, "low-50", "low-20", "unused-headroom")

        fun key(provider: String, window: String) = "$provider/$window"

        /** A window of a day or less, as `alertsFor` tells them apart. */
        fun isShort(minutes: Int?) = minutes != null && minutes <= 24 * 60

        /**
         * Settings from before #914: a bell per provider and two switches, "runs low" (50% and 20%
         * left) and "runs out" (which also covered unused headroom). Each provider with its bell on
         * keeps what the switches let through; the others get the defaults.
         */
        fun migrate(notify: List<String>, low: Boolean, pace: Boolean): QuotaAlerts {
            val kept = buildList {
                if (pace) add(RUNS_OUT)
                if (low) addAll(listOf("low-50", "low-20"))
                if (pace) add("unused-headroom")
            }
            return QuotaAlerts(windows = notify.associateWith { kept })
        }
    }
}

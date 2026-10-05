package dev.starbridge.app.data

import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.Serializable

/**
 * Quota settings, per phone (SPEC.md, "Quota settings follow CodexBar"): a curated set of
 * CodexBar's own settings with CodexBar's meaning. They stay on the phone; the server learns
 * nothing of them. The web page keeps the same set (web/src/lib/quotaSettings.ts).
 */
@Serializable
data class QuotaSettings(
    /** The bar and the percentage show used, else remaining (CodexBar `usageBarsShowUsed`). */
    val showUsed: Boolean = true,
    /** Reset times as a clock time, else "in 2 h" (`resetTimesShowAbsolute`). */
    val absoluteResets: Boolean = false,
    /** Workdays a week on weekly bars, from Monday (`weeklyProgressWorkDays`); null is off. */
    val workDays: Int? = null,
    /** How the workday ticks show (`workdayTickAppearance`). */
    val ticks: Ticks = Ticks.Subtle,
    /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
    val order: List<String> = emptyList(),
    val hidden: List<String> = emptyList(),
    /** Providers whose alerts notify; none by default. */
    val notify: List<String> = emptyList(),
    /** Notify when a window reaches 50% or 20% left (`quotaWarningThresholds`). */
    val notifyLow: Boolean = true,
    /** Notify when a window will run out, or resets with headroom unused (`predictivePaceWarning…`). */
    val notifyPace: Boolean = true,
) {
    enum class Ticks { Subtle, HighContrast, Hidden }

    /** Every provider the windows name, in this order. */
    fun providers(windows: List<QuotaWindow>): List<String> {
        val seen = windows.map { it.provider }.distinct()
        val known = order.filter { it in seen }
        return known + seen.filter { it !in known }
    }

    /**
     * The windows to show: hidden providers out, then this order. With no order set, windows with
     * an alert come first, as before the setting existed.
     */
    fun arrange(windows: List<QuotaWindow>, now: Instant): List<QuotaWindow> {
        val shown = windows.filter { it.provider !in hidden }
        if (order.isEmpty()) return shown.sortedByDescending { it.alert && it.resetsAt?.isAfter(now) != false }
        val rank = providers(windows).withIndex().associate { (i, p) -> p to i }
        return shown.sortedBy { rank[it.provider] ?: 0 }
    }

    /** Whether this phone shows a notification for [notice]. */
    fun wants(notice: QuotaNotice) =
        notice.provider in notify && if (notice.kind == "low") notifyLow else notifyPace

    /** CodexBar's workday ticks: one per workday boundary, evenly spaced along a weekly bar. */
    fun ticks(window: QuotaWindow): List<Float> {
        val days = workDays ?: return emptyList()
        if (ticks == Ticks.Hidden || window.windowMinutes != WEEK) return emptyList()
        return (1 until days).map { it.toFloat() / days }
    }

    /** What a card's bar shows: its percentage, fill and pace marker, all on the same scale. */
    fun bar(window: QuotaWindow, now: Instant, zone: ZoneId = ZoneId.systemDefault()): Bar {
        val used = window.usedPercent.coerceIn(0, 100)
        val steady = workdayExpected(window, workDays, now, zone)?.let { Math.round(it) } ?: window.steadyPercent
        return Bar(
            percent = if (showUsed) used else 100 - used,
            word = if (showUsed) "used" else "left",
            steady = steady?.let { if (showUsed) it else 100 - it },
            ticks = ticks(window),
        )
    }

    data class Bar(val percent: Int, val word: String, val steady: Int?, val ticks: List<Float>)

    companion object {
        const val WEEK = 10080

        /**
         * Where an even pace over workdays only would be now, in percent used, as CodexBar's
         * `UsagePace.weekly`: the week splits at local midnights, and Monday to the
         * [workDays]-th day count. Null when it does not apply: no setting, 7 days, or not weekly.
         */
        fun workdayExpected(window: QuotaWindow, workDays: Int?, now: Instant, zone: ZoneId = ZoneId.systemDefault()): Double? {
            val end = window.resetsAt ?: return null
            if (workDays == null || workDays >= 7 || window.windowMinutes != WEEK) return null
            var cursor = end.minusSeconds(WEEK * 60L)
            var total = 0L
            var elapsed = 0L
            while (cursor.isBefore(end)) {
                val day = cursor.atZone(zone)
                val next = day.toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
                val sliceEnd = if (next.isBefore(end)) next else end
                if (day.dayOfWeek.value <= workDays) {
                    total += sliceEnd.toEpochMilli() - cursor.toEpochMilli()
                    if (now.isAfter(cursor)) elapsed += minOf(now, sliceEnd).toEpochMilli() - cursor.toEpochMilli()
                }
                cursor = sliceEnd
            }
            return if (total > 0) (elapsed * 100.0 / total).coerceIn(0.0, 100.0) else null
        }
    }
}

/** A quota alert the uploader newly raised, for a notification. */
data class QuotaNotice(
    /** The snapshot and alert, so each shows once. */
    val key: String,
    val provider: String,
    val window: String,
    val kind: String,
    val title: String,
    val text: String,
)

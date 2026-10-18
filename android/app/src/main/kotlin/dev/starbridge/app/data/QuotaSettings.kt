package dev.starbridge.app.data

import dev.starbridge.app.protocol.arrangeQuotas
import dev.starbridge.app.protocol.quotaProviders
import dev.starbridge.app.protocol.quotaRunningOut
import java.text.Collator
import java.time.Instant
import java.time.ZoneId
import kotlin.math.roundToInt
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Quota settings, per phone (spec/items.md, "Quota settings follow CodexBar"): a curated set of
 * CodexBar's own settings with CodexBar's meaning. They stay on the phone; the server learns
 * nothing of them. The web page keeps the same set (web/src/lib/quotaSettings.ts).
 */
@Serializable
data class QuotaSettings(
    /** The bar and the percentage show used, else remaining (CodexBar `usageBarsShowUsed`). */
    val showUsed: Boolean = true,
    /** Reset times as a clock time, else "in 2 h" (`absoluteResets`). */
    val absoluteResets: Boolean = false,
    /** Workdays a week on weekly bars, from Monday (`weeklyProgressWorkDays`); null is off. */
    val workDays: Int? = null,
    /** Providers in the order to show them; the ones not listed follow in the uploader's order. */
    val order: List<String> = emptyList(),
    /** Windows that will run out or ran out lead, else [order] holds for every window. */
    val runningOutFirst: Boolean = true,
    val hidden: List<String> = emptyList(),
    /** Which alerts notify, per window (#914). */
    val alerts: QuotaAlerts = QuotaAlerts(),
) {

    /** Every provider the windows name, in this order. */
    fun providers(windows: List<QuotaWindow>): List<String> = quotaProviders(windows.map { it.provider }, order)

    /**
     * The windows to show (spec/items.md, "Quota order"): hidden providers out, the rest by provider in
     * this order, a provider's machines by name (the server sends them by machine id, which differs
     * between accounts), each machine's windows in the uploader's order. With [runningOutFirst], windows
     * that will run out or ran out, and have not reset, lead in that same order.
     */
    fun arrange(windows: List<QuotaWindow>, now: Instant): List<QuotaWindow> {
        val byName = Collator.getInstance()
        return arrangeQuotas(
            windows, order, hidden, runningOutFirst,
            provider = { it.provider },
            machine = { it.machine },
            runningOut = { quotaRunningOut(it.pace.course, it.resetsAt, now) },
            names = { a, b -> byName.compare(a, b) },
        )
    }

    /**
     * Arranged windows under one heading per provider and machine (#160): groups in the order
     * their first window comes, so a provider with a window running out leads.
     */
    fun groups(arranged: List<QuotaWindow>): List<List<QuotaWindow>> =
        arranged.groupBy { it.provider to it.machine }.values.toList()

    /** Whether this phone shows a notification for [notice]. */
    fun wants(notice: QuotaNotice) = alerts.wants(notice.provider, notice.window, notice.kind, notice.threshold, notice.minutes)

    /** CodexBar's workday ticks: one per workday boundary, evenly spaced along a weekly bar. */
    fun ticks(window: QuotaWindow): List<Float> {
        val days = workDays ?: return emptyList()
        if (window.windowMinutes != WEEK) return emptyList()
        return (1 until days).map { it.toFloat() / days }
    }

    /** What a card's bar shows: its percentage, fill and pace marker, all on the same scale. */
    fun bar(window: QuotaWindow, now: Instant, zone: ZoneId = ZoneId.systemDefault()): Bar {
        val used = window.usedPercent.coerceIn(0, 100)
        val steady = workdayExpected(window, workDays, now, zone)?.roundToInt() ?: window.steadyPercent
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
         * Settings as stored, from this release or an older one, whose tick style's "Hidden" was
         * ticks off. The bell and switches of releases before #914 are dropped: their alerts are
         * the defaults.
         */
        fun read(json: Json, text: String): QuotaSettings {
            val o = json.parseToJsonElement(text).jsonObject
            val s = json.decodeFromJsonElement(serializer(), o)
            return s.copy(workDays = if (o["ticks"]?.jsonPrimitive?.contentOrNull == "Hidden") null else s.workDays)
        }

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
    /** A `low` alert's level, percent left. */
    val threshold: Int? = null,
    /** The window's length, which picks its default alerts. */
    val minutes: Int? = null,
)

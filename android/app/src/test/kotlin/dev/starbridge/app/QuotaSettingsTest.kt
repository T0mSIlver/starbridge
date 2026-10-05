package dev.starbridge.app

import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.QuotaNotice
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuotaSettingsTest {
    private val zone = ZoneId.of("Europe/Paris")
    private fun local(day: Int, hour: Int = 0) = LocalDateTime.of(2026, 10, day, hour, 0).atZone(zone).toInstant()

    // The week runs from Monday 5 October to Monday 12 October at local midnight.
    private val week = QuotaWindow("w", "claude", "Weekly", 30, local(12), Pace.Even, steadyPercent = 29, windowMinutes = 10080)

    @Test fun workdaysCountMondayToFridayOnly() {
        // Wednesday midnight: 2 of 5 workdays passed, where the plain week is 2 of 7.
        assertEquals(40.0, QuotaSettings.workdayExpected(week, 5, local(7), zone)!!, 0.01)
        assertEquals(100.0, QuotaSettings.workdayExpected(week, 4, local(10, 12), zone)!!, 0.01)
        assertNull(QuotaSettings.workdayExpected(week, 7, local(7), zone))
        assertNull(QuotaSettings.workdayExpected(week.copy(windowMinutes = 300), 5, local(7), zone))
    }

    @Test fun barFollowsUsedOrRemaining() {
        assertEquals(QuotaSettings.Bar(30, "used", 29, emptyList()), QuotaSettings().bar(week, local(7), zone))
        assertEquals(
            QuotaSettings.Bar(70, "left", 60, listOf(0.2f, 0.4f, 0.6f, 0.8f)),
            QuotaSettings(showUsed = false, workDays = 5).bar(week, local(7), zone),
        )
    }

    // The same cases as the web's quotaSettings.test.ts (SPEC.md, "Quota order"). Wednesday noon.
    private val noon = local(7, 12)
    private fun win(provider: String, label: String, pace: Pace, resetsAt: Instant = local(12)) =
        week.copy(id = "$provider/$label", provider = provider, window = label, pace = pace, resetsAt = resetsAt, alert = pace is Pace.Unused)

    // In the uploader's order: claude's two windows apart, a headroom alert, one that will run out,
    // one that ran out, one that ran out and has since reset.
    private val windows = listOf(
        win("claude", "5-hour", Pace.Even),
        win("zai", "5-hour", Pace.Unused(40)),
        win("codex", "Weekly", Pace.RunsOut(local(8))),
        win("claude", "Weekly", Pace.RunsOut(local(7, 9))),
        win("gemini", "Daily", Pace.RunsOut(local(7, 9)), resetsAt = local(7, 10)),
        win("mistral", "Monthly", Pace.Even),
    )
    private fun arranged(s: QuotaSettings) = s.copy(hidden = listOf("mistral")).arrange(windows, noon).map { "${it.provider} ${it.window}" }

    @Test fun arrangeRunningOutFirstThenUploaderOrder() {
        assertEquals(listOf("claude Weekly", "codex Weekly", "claude 5-hour", "zai 5-hour", "gemini Daily"), arranged(QuotaSettings()))
    }

    @Test fun arrangeRunningOutFirstThenOrderSet() {
        assertEquals(listOf("claude Weekly", "codex Weekly", "zai 5-hour", "gemini Daily", "claude 5-hour"), arranged(QuotaSettings(order = listOf("zai", "gemini"))))
    }

    @Test fun arrangeKeepsOrderSetWhenRunningOutFirstIsOff() {
        assertEquals(
            listOf("zai 5-hour", "gemini Daily", "claude 5-hour", "claude Weekly", "codex Weekly"),
            arranged(QuotaSettings(order = listOf("zai", "gemini"), runningOutFirst = false)),
        )
    }

    @Test fun notifiesOnlyOptedInProvidersAndKinds() {
        fun n(provider: String, kind: String) = QuotaNotice("k", provider, "primary", kind, "", "")
        val off = QuotaSettings()
        val zai = QuotaSettings(notify = listOf("zai"), notifyLow = false)
        assertEquals(false, off.wants(n("zai", "low")))
        assertEquals(false, zai.wants(n("zai", "low")))
        assertEquals(true, zai.wants(n("zai", "runs-out")))
        assertEquals(false, zai.wants(n("claude", "runs-out")))
    }
}

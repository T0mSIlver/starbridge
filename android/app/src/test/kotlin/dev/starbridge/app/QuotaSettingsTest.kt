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

    @Test fun arrangeHidesAndOrders() {
        val windows = listOf(
            week,
            week.copy(id = "z", provider = "zai", alert = true),
            week.copy(id = "c", provider = "codex"),
        )
        assertEquals(listOf("zai", "claude", "codex"), QuotaSettings().arrange(windows, local(7)).map { it.provider })
        assertEquals(listOf("codex", "zai"), QuotaSettings(order = listOf("codex"), hidden = listOf("claude")).arrange(windows, local(7)).map { it.provider })
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

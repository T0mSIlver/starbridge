package dev.starbridge.app

import dev.starbridge.app.ui.clockAt
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

// DateFormat.getBestDateTimePattern comes from Android, so Robolectric runs these.
@RunWith(RobolectricTestRunner::class)
class TimeTest {
    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private fun at(at: String, h24: Boolean, locale: Locale = Locale.US) = clockAt(Instant.parse(at), now, h24, ZoneOffset.UTC, locale)

    @Test fun aTimeTodayTomorrowLaterOrPast() {
        assertEquals("at 15:55", at("2026-10-04T15:55:00Z", true))
        assertEquals("tomorrow at 10:15", at("2026-10-05T10:15:00Z", true))
        assertEquals("on Oct 8 at 10:15", at("2026-10-08T10:15:00Z", true))
        assertEquals("yesterday at 22:05", at("2026-10-03T22:05:00Z", true))
        assertEquals("on Oct 1 at 09:00", at("2026-10-01T09:00:00Z", true))
    }

    @Test fun twelveHourClock() {
        assertEquals("at 3:55 PM", at("2026-10-04T15:55:00Z", false).replace('\u202f', ' '))
        assertEquals("on Oct 8 at 10:15 AM", at("2026-10-08T10:15:00Z", false).replace('\u202f', ' '))
    }

    @Test fun datesFollowThePhonesLanguage() {
        assertEquals("on 7 oct. at 09:00", at("2026-10-07T09:00:00Z", true, Locale.FRANCE))
    }
}

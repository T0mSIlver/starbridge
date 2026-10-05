package dev.starbridge.app

import dev.starbridge.app.ui.resetClock
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
    private fun reset(at: String, h24: Boolean, locale: Locale) = resetClock(Instant.parse(at), now, h24, ZoneOffset.UTC, locale)

    @Test fun resetsFollowTheClockSetting() {
        assertEquals("22:00", reset("2026-10-04T22:00:00Z", true, Locale.US))
        assertEquals("10:00 PM", reset("2026-10-04T22:00:00Z", false, Locale.US).replace(' ', ' '))
        assertEquals("tomorrow 09:05", reset("2026-10-05T09:05:00Z", true, Locale.US))
    }

    @Test fun datesFollowThePhonesLanguage() {
        assertEquals("Oct 7, 09:00", reset("2026-10-07T09:00:00Z", true, Locale.US))
        assertEquals("7 oct., 09:00", reset("2026-10-07T09:00:00Z", true, Locale.FRANCE))
    }
}

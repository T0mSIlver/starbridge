package dev.starbridge.app

import dev.starbridge.app.ui.moment
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class TimeTest {
    private val now = Instant.parse("2026-10-04T14:00:00Z")

    // A fallback set for another day must not read like one already past today.
    @Test fun fallbackTimeNamesItsDay() {
        assertEquals("at 22:00", moment(Instant.parse("2026-10-04T22:00:00Z"), now, ZoneOffset.UTC))
        assertEquals("tomorrow at 10:00", moment(Instant.parse("2026-10-05T10:00:00Z"), now, ZoneOffset.UTC))
        assertEquals("on Wed 7 Oct at 09:00", moment(Instant.parse("2026-10-07T09:00:00Z"), now, ZoneOffset.UTC))
    }
}

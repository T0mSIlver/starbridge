package dev.starbridge.app

import dev.starbridge.app.data.SwipeSnooze
import dev.starbridge.app.ui.inbox.snoozeDays
import dev.starbridge.app.ui.inbox.snoozeStart
import dev.starbridge.app.ui.inbox.until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

// Where the snooze dial starts and what a swipe right picks (#692), in Paris time.
class SnoozeTimesTest {
    private val paris = ZoneId.of("Europe/Paris")
    private fun at(local: String) = java.time.LocalDateTime.parse(local).atZone(paris).toInstant()
    private val today = LocalDate.parse("2026-10-07")

    @Test fun theDialStartsAnHourAheadUpToTheHalfHour() {
        assertEquals(LocalTime.of(15, 0), snoozeStart(today, at("2026-10-07T14:00"), paris))
        assertEquals(LocalTime.of(15, 30), snoozeStart(today, at("2026-10-07T14:10"), paris))
        assertEquals(LocalTime.of(16, 0), snoozeStart(today, at("2026-10-07T14:40"), paris))
    }

    @Test fun lateInTheEveningTheDialStaysOnToday() {
        assertEquals(LocalTime.of(23, 30), snoozeStart(today, at("2026-10-07T23:10"), paris))
    }

    @Test fun anotherDayStartsInTheMorning() {
        assertEquals(LocalTime.of(9, 0), snoozeStart(today.plusDays(1), at("2026-10-07T14:10"), paris))
    }

    @Test fun theDaysAreTodayAndTheSevenAfter() {
        val days = snoozeDays(at("2026-10-07T14:00"), paris)
        assertEquals(8, days.size)
        assertEquals(today, days.first())
        assertEquals(today.plusDays(7), days.last())
    }

    @Test fun aSwipeSnoozesForTheSetTimeOrAsks() {
        val now = at("2026-10-07T14:10")
        assertEquals(at("2026-10-07T15:10"), SwipeSnooze.Hour.until(now, paris))
        assertEquals(at("2026-10-07T17:10"), SwipeSnooze.ThreeHours.until(now, paris))
        assertEquals(at("2026-10-08T09:00"), SwipeSnooze.Morning.until(now, paris))
        // At 1:00 the morning is this one.
        assertEquals(at("2026-10-08T09:00"), SwipeSnooze.Morning.until(at("2026-10-08T01:00"), paris))
        assertNull(SwipeSnooze.Ask.until(now, paris))
    }
}

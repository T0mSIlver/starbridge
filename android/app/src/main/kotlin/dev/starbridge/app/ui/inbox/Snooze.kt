package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.theme.Spacing
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.starbridge.app.data.Decision
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.TextStyle
import java.util.Locale

// Snoozing a question (#571), as on the web (web/src/lib/snooze.ts): times resolve on the phone,
// in its zone, and travel as absolute times.

/** The latest a snooze may run: an unanswered question drops 30 days after it came. */
val SNOOZE_MAX: Duration = Duration.ofDays(7)

private const val EVENING = 18
private const val EVENING_UNTIL = 17
private const val MORNING = 9
/** Before this hour, "Tomorrow morning" is this morning: at 1:00 the owner means in 8 hours. */
private const val NIGHT_ENDS = 5

/** 1 hour, This evening (until 17:00), Tomorrow morning: the menu's fixed times. */
fun snoozePresets(now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<Pair<String, Instant>> {
    val local = now.atZone(zone)
    val today = local.toLocalDate()
    fun at(day: LocalDate, hour: Int) = day.atTime(hour, 0).atZone(zone).toInstant()
    return listOfNotNull(
        "1 hour" to now.plus(Duration.ofHours(1)),
        if (local.hour < EVENING_UNTIL) "This evening" to at(today, EVENING) else null,
        "Tomorrow morning" to at(if (local.hour < NIGHT_ENDS) today else today.plusDays(1), MORNING),
    )
}

/** Whether [until] is a time a snooze may take: after now, at most 7 days ahead. */
fun snoozeAllowed(until: Instant, now: Instant) = until.isAfter(now) && !until.isAfter(now.plus(SNOOZE_MAX))

/** Whether the owner put [this] off and its time has not come. */
fun Decision.snoozed(now: Instant) = isOpen && snoozedUntil?.isAfter(now) == true

/**
 * "18:00", "tomorrow 09:00", "Fri 09:00": when a snooze ends, short enough for a time slot.
 * [named] leaves out "tomorrow" for the menu, whose "Tomorrow morning" says it already.
 */
fun snoozeTime(until: Instant, now: Instant, h24: Boolean, named: Boolean = false, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val time = clock(until, h24, zone, locale)
    val day = until.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    return when {
        day == today -> time
        day == today.plusDays(1) -> if (named) time else "tomorrow $time"
        // A week ahead is the same weekday as today: the date tells them apart.
        day.isAfter(today.plusDays(6)) -> "${dev.starbridge.app.ui.day(until, zone, locale)} $time"
        else -> "${day.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)} $time"
    }
}

/**
 * Snooze's times, open under the quiet buttons as Reply's field opens (#571): 1 hour, This
 * evening, Tomorrow morning, each with the time it brings the question back, and Pick a time,
 * a day then a time up to 7 days ahead.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnoozeTimes(now: Instant, onSnooze: (Instant) -> Unit) {
    var pickDay by remember { mutableStateOf(false) }
    var day by remember { mutableStateOf<LocalDate?>(null) }
    val h24 = LocalClock24.current
    val scheme = MaterialTheme.colorScheme
    val presets = snoozePresets(now)
    val rows = presets.size + 1
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.semantics { contentDescription = "Snooze until" }) {
        presets.forEachIndexed { i, (name, until) ->
            Row(i, rows, { onSnooze(until) }) {
                Text(name, style = StarbridgeTheme.type.body, color = scheme.onSurface, modifier = Modifier.weight(1f))
                Text(snoozeTime(until, now, h24, named = name == "Tomorrow morning"), style = StarbridgeTheme.type.machine, color = scheme.onSurfaceVariant)
            }
        }
        Row(presets.size, rows, { pickDay = true }) {
            Text("Pick a time", style = StarbridgeTheme.type.body, color = scheme.onSurface, modifier = Modifier.weight(1f))
        }
    }
    val zone = ZoneId.systemDefault()
    val today = now.atZone(zone).toLocalDate()
    if (pickDay) {
        // The picker counts days in UTC milliseconds.
        val utc = { d: LocalDate -> d.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }
        val last = now.plus(SNOOZE_MAX).atZone(zone).toLocalDate()
        val state = rememberDatePickerState(
            initialSelectedDateMillis = utc(today),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis in utc(today)..utc(last)
                override fun isSelectableYear(year: Int) = year in today.year..last.year
            },
        )
        DatePickerDialog(
            onDismissRequest = { pickDay = false },
            confirmButton = {
                TextButton(onClick = {
                    pickDay = false
                    day = state.selectedDateMillis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                }) { Text("Next") }
            },
            dismissButton = { TextButton(onClick = { pickDay = false }) { Text("Cancel") } },
        ) { DatePicker(state, showModeToggle = false) }
    }
    day?.let { picked ->
        // Today, an hour from now; another day, the morning.
        val start = if (picked == today) now.atZone(zone).toLocalTime().plusHours(1) else LocalTime.of(MORNING, 0)
        val state = rememberTimePickerState(initialHour = start.hour, initialMinute = 0, is24Hour = h24)
        val until = picked.atTime(state.hour, state.minute).atZone(zone).toInstant()
        AlertDialog(
            onDismissRequest = { day = null },
            title = { Text("Snooze until") },
            text = { TimePicker(state) },
            confirmButton = { TextButton(onClick = { day = null; onSnooze(until) }, enabled = snoozeAllowed(until, now)) { Text("Snooze") } },
            dismissButton = { TextButton(onClick = { day = null }) { Text("Cancel") } },
        )
    }
}

/** One time in the list: a segment of a connected group, as the options are. */
@Composable
private fun Row(index: Int, count: Int, onClick: () -> Unit, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val end = 20.dp
    val shape = RoundedCornerShape(
        topStart = if (index == 0) end else 4.dp, topEnd = if (index == 0) end else 4.dp,
        bottomStart = if (index == count - 1) end else 4.dp, bottomEnd = if (index == count - 1) end else 4.dp,
    )
    Surface(onClick = onClick, shape = shape, color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
        androidx.compose.foundation.layout.Row(Modifier.heightIn(min = 56.dp).padding(horizontal = Spacing.s5), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

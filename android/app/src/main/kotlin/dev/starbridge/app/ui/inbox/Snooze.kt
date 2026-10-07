package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import kotlinx.coroutines.launch
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.theme.Spacing
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import dev.starbridge.app.ui.SheetGround
import dev.starbridge.app.ui.SheetHandle
import dev.starbridge.app.ui.SheetShape
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Button
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.SwipeSnooze
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
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
        "Tomorrow morning" to morning(now, zone),
    )
}

/** Tomorrow at 9:00, or this morning before [NIGHT_ENDS]. */
private fun morning(now: Instant, zone: ZoneId): Instant {
    val local = now.atZone(zone)
    val day = if (local.hour < NIGHT_ENDS) local.toLocalDate() else local.toLocalDate().plusDays(1)
    return day.atTime(MORNING, 0).atZone(zone).toInstant()
}

/** When a swipe right snoozes a question until, from [now]; null when it asks (#692). */
fun SwipeSnooze.until(now: Instant, zone: ZoneId = ZoneId.systemDefault()): Instant? = when (this) {
    SwipeSnooze.Hour -> now.plus(Duration.ofHours(1))
    SwipeSnooze.ThreeHours -> now.plus(Duration.ofHours(3))
    SwipeSnooze.Morning -> morning(now, zone)
    SwipeSnooze.Ask -> null
}

/** The shortest snooze: a device tells its first push from its return by it (ServerStore). */
val SNOOZE_MIN: Duration = Duration.ofMinutes(5)

/** Whether [until] is a time a snooze may take: 5 minutes from now on, at most 7 days ahead. */
fun snoozeAllowed(until: Instant, now: Instant) = !until.isBefore(now.plus(SNOOZE_MIN)) && !until.isAfter(now.plus(SNOOZE_MAX))

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

/** The days a snooze can end on: today and the 7 after it (#692). */
fun snoozeDays(now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<LocalDate> {
    val today = now.atZone(zone).toLocalDate()
    return (0L..SNOOZE_MAX.toDays()).map { today.plusDays(it) }
}

/** The dial's first time on [day]: today an hour ahead, up to the half hour; another day 9:00. */
fun snoozeStart(day: LocalDate, now: Instant, zone: ZoneId = ZoneId.systemDefault()): LocalTime {
    val local = now.atZone(zone)
    if (day != local.toLocalDate()) return LocalTime.of(MORNING, 0)
    val ahead = local.plusHours(1).withSecond(0).withNano(0)
    val up = if (ahead.minute % 30 == 0) ahead else ahead.withMinute(0).plusMinutes(if (ahead.minute < 30) 30L else 60L)
    // Late in the evening that would be tomorrow: the dial stays on today's last half hour.
    return if (up.toLocalDate() == day) up.toLocalTime() else LocalTime.of(23, 30)
}

/** "Today", "Tomorrow", then "Fri 9": a day's chip. */
private fun dayLabel(day: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()) = when (day) {
    today -> "Today"
    today.plusDays(1) -> "Tomorrow"
    else -> "${day.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)} ${day.dayOfMonth}"
}

/**
 * Snooze's times, open under the quiet buttons as Reply's field opens (#571), straight on a time
 * (#692): 1 hour and This evening, each with the time it brings the question back, then the days
 * as chips, today first, and the dial on today an hour ahead, with Snooze to confirm.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnoozeTimes(now: Instant, modifier: Modifier = Modifier, onSnooze: (Instant) -> Unit) {
    val zone = ZoneId.systemDefault()
    val h24 = LocalClock24.current
    val scheme = MaterialTheme.colorScheme
    val days = snoozeDays(now, zone)
    var day by rememberSaveable { mutableStateOf(days.first()) }
    val start = snoozeStart(day, now, zone)
    val dial = rememberTimePickerState(initialHour = start.hour, initialMinute = start.minute, is24Hour = h24)
    val presets = snoozePresets(now, zone).filter { (name, _) -> name != "Tomorrow morning" }
    val until = day.atTime(dial.hour, dial.minute).atZone(zone).toInstant()
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s4), modifier = modifier.semantics { contentDescription = "Snooze until" }) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            presets.forEachIndexed { i, (name, at) ->
                Row(i, presets.size, { onSnooze(at) }) {
                    Text(name, style = StarbridgeTheme.type.body, color = scheme.onSurface, modifier = Modifier.weight(1f))
                    Text(snoozeTime(at, now, h24), style = StarbridgeTheme.type.machine, color = scheme.onSurfaceVariant)
                }
            }
        }
        androidx.compose.foundation.layout.Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            days.forEach { d ->
                FilterChip(
                    selected = d == day,
                    onClick = {
                        day = d
                        snoozeStart(d, now, zone).let { dial.hour = it.hour; dial.minute = it.minute }
                    },
                    label = { Text(dayLabel(d, days.first())) },
                )
            }
        }
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TimePicker(dial) }
        Button(
            onClick = { onSnooze(until) },
            enabled = snoozeAllowed(until, now),
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) { Text("Snooze until ${snoozeTime(until, now, h24)}", style = StarbridgeTheme.type.action) }
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

/** How far a card goes before letting go snoozes it (#692): 40% of its width. */
private const val SWIPE_ARMS = 0.4f

/**
 * A question's card that snoozes on a swipe right (#692): past [SWIPE_ARMS] the panel behind it
 * darkens, its icon fills and the phone ticks; let go there and [onSwipe] snoozes it, or opens the
 * times, while the card slides back. Let go earlier and nothing happens.
 */
@Composable
fun SwipeToSnooze(shape: Shape, onSwipe: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(positionalThreshold = { it * SWIPE_ARMS })
    val scope = rememberCoroutineScope()
    // One lambda for the card's life: Material re-runs a new one while the card still sits
    // swiped, which would snooze twice.
    val swiped by rememberUpdatedState(onSwipe)
    val dismiss: (SwipeToDismissBoxValue) -> Unit = remember(state) {
        {
            swiped()
            scope.launch { state.reset() }
        }
    }
    val haptics = LocalHapticFeedback.current
    var width by remember { mutableStateOf(0) }
    // From the offset, the threshold's own measure: the target value lags a slow drag.
    val armed by remember { derivedStateOf { width > 0 && state.offsetOrZero() >= width * SWIPE_ARMS } }
    LaunchedEffect(armed) {
        if (armed) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
    }
    SwipeToDismissBox(
        state,
        backgroundContent = {
            // Only while it moves: at rest the panel would show at the card's rounded edges.
            val moving = state.dismissDirection != SwipeToDismissBoxValue.Settled
            val scheme = MaterialTheme.colorScheme
            val tint = if (armed) scheme.onSecondaryContainer else scheme.onSurfaceVariant
            if (moving) Surface(Modifier.fillMaxWidth().fillMaxHeight(), shape = shape, color = if (armed) scheme.secondaryContainer else scheme.surfaceContainerHighest) {
                androidx.compose.foundation.layout.Row(
                    Modifier.fillMaxHeight().padding(horizontal = Spacing.s5),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Symbol(Sym.Snooze, size = 24.dp, filled = armed, tint = tint)
                    Spacer(Modifier.width(Spacing.s2))
                    Text("Snooze", style = StarbridgeTheme.type.label, color = tint)
                }
            }
        },
        enableDismissFromEndToStart = false,
        modifier = modifier.onSizeChanged { width = it.width }.semantics {
            customActions = listOf(CustomAccessibilityAction("Snooze") { onSwipe(); true })
        },
        onDismiss = dismiss,
    ) { content() }
}

/**
 * The times over the inbox, for a swiped card (#692): what the agent asked, then the times the
 * sheet's Snooze opens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnoozeSheet(decision: Decision, now: Instant, onDismiss: () -> Unit, onSnooze: (Instant) -> Unit) {
    val ground = remember { SheetGround() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = SheetShape,
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        scrimColor = StarbridgeTheme.colors.scrim,
        dragHandle = { SheetHandle(ground.color) },
    ) {
        Column(
            // The dial is tall: on a short screen the sheet scrolls to its Snooze button.
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = Spacing.s5).padding(bottom = Spacing.s5),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            Text(decision.question, style = StarbridgeTheme.type.subtitle, color = MaterialTheme.colorScheme.onSurface)
            SnoozeTimes(now, onSnooze = onSnooze)
        }
    }
}

/** The card's offset, 0 before its first layout sets the swipe's anchors. */
private fun SwipeToDismissBoxState.offsetOrZero() = runCatching { requireOffset() }.getOrDefault(0f)

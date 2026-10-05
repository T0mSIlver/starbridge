package dev.starbridge.app.ui

import android.text.format.DateFormat
import androidx.compose.runtime.staticCompositionLocalOf
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "38 min", "1 h 50 min", "2 d 4 h": the two largest units, rounded down. */
fun span(from: Instant, to: Instant): String {
    val minutes = Duration.between(from, to).toMinutes().coerceAtLeast(0)
    val d = minutes / (60 * 24)
    val h = minutes / 60 % 24
    val m = minutes % 60
    return when {
        d > 0 -> if (h > 0) "$d d $h h" else "$d d"
        h > 0 -> if (m > 0) "$h h $m min" else "$h h"
        else -> "$m min"
    }
}

/** "8 s", "2 min 05 s", "1 h 03 min": a run's time, to the second while it is short. */
fun elapsed(from: Instant, to: Instant): String {
    val s = Duration.between(from, to).seconds.coerceAtLeast(0)
    return when {
        s < 60 -> "$s s"
        s < 3600 -> "${s / 60} min ${"%02d".format(s % 60)} s"
        else -> "${s / 3600} h ${"%02d".format(s % 3600 / 60)} min"
    }
}

fun ago(now: Instant, then: Instant): String =
    if (Duration.between(then, now).toMinutes() < 1) "just now" else "${span(then, now)} ago"

/**
 * Whether times read 24-hour: the Clock setting, else the phone's own choice. The root provides
 * it; 24-hour where nothing does, as in screenshots.
 */
val LocalClock24 = staticCompositionLocalOf { true }

/** The phone's language's own pattern for [skeleton], such as "MMM d" in English, "d MMM" in French. */
private fun format(skeleton: String, locale: Locale) =
    DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale)

/** "22:00" or "10:00 PM" in the phone's zone. */
fun clock(at: Instant, h24: Boolean, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    format(if (h24) "Hm" else "hm", locale).withZone(zone).format(at)

/** A date without the year in the phone's language: "Oct 7", "7 oct." */
fun day(at: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    format("MMMd", locale).withZone(zone).format(at)

/** CodexBar's absolute reset: "14:30" today, "tomorrow 14:30", else "Oct 7, 22:00". */
fun resetClock(at: Instant, now: Instant, h24: Boolean, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val time = clock(at, h24, zone, locale)
    return when (at.atZone(zone).toLocalDate()) {
        now.atZone(zone).toLocalDate() -> time
        now.atZone(zone).toLocalDate().plusDays(1) -> "tomorrow $time"
        else -> "${day(at, zone, locale)}, $time"
    }
}

/** "now", "12 min", "2 h 5 min": how long ago, for a meta row. */
fun since(then: Instant, now: Instant): String =
    if (Duration.between(then, now).toMinutes() < 1) "now" else span(then, now)

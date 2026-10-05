package dev.starbridge.app.ui

import java.time.Duration
import java.time.Instant

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

fun ago(now: Instant, then: Instant): String =
    if (Duration.between(then, now).toMinutes() < 1) "just now" else "${span(then, now)} ago"

/** "at 22:00" today, "tomorrow at 09:00", else "on Tue 6 Oct at 09:00", in the phone's zone. */
fun moment(at: Instant, now: Instant, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
    val day = at.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    val time = "at ${clock(at, zone)}"
    return when (day) {
        today -> time
        today.plusDays(1) -> "tomorrow $time"
        else -> "on ${java.time.format.DateTimeFormatter.ofPattern("EEE d MMM", java.util.Locale.ENGLISH).format(day)} $time"
    }
}

/** "22:00" in the phone's zone. */
fun clock(at: Instant, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
    java.time.format.DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(at)

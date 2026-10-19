package dev.starbridge.app.data

import java.time.Instant
import java.time.temporal.ChronoUnit

// Which of two updates of one decision every client keeps, whatever order they arrive in: a push
// and a poll bring them in different orders on different devices. The web, the CLI and iOS apply
// the same rule; packages/protocol/vectors/rules.json, "order", holds its cases (#2103).

/**
 * Whether the snooze at [at] until [until] replaces the one kept at [keptAt]: the later instant,
 * and on equal instants the earlier `until`, so a question shows rather than hides.
 */
internal fun laterSnooze(keptAt: String?, keptUntil: String?, at: String, until: String): Boolean {
    val next = instant(at) ?: return false
    val kept = instant(keptAt) ?: return true
    if (kept != next) return next.isAfter(kept)
    val a = instant(keptUntil) ?: return false
    val b = instant(until) ?: return false
    return b.isBefore(a)
}

/** Whether waiting state [state] at [at] replaces [keptState] at [keptAt]; on a tie, waiting. */
internal fun laterWaiting(keptAt: String?, keptState: String?, at: String, state: String): Boolean {
    val next = instant(at) ?: return false
    val kept = instant(keptAt) ?: return true
    if (kept != next) return next.isAfter(kept)
    return state == "waiting" && keptState != "waiting"
}

/** The `at` of a snooze sent at [now]: whole seconds, past [last], the latest one known. */
internal fun snoozeStamp(now: Instant, last: String?): String =
    listOfNotNull(now.truncatedTo(ChronoUnit.SECONDS), instant(last)?.truncatedTo(ChronoUnit.SECONDS)?.plusSeconds(1)).max().toString()

package dev.starbridge.app.data

import kotlinx.serialization.Serializable
import java.time.Instant

// What a push about one question does to its notification, whatever order pushes arrive in and
// however often (#2151): packages/protocol/src/notify.ts's `notifyStep`, which the web and iOS
// apply too; packages/protocol/vectors/rules.json, "notify", holds its cases.

/**
 * What this phone remembers of the pushes about one question: [closed] by an `answered` or
 * settled push (unverified, so it only keeps notifications down), [rang] once, the last waiting
 * flip applied, and the `at` of the latest snooze whose return rang.
 */
@Serializable
data class Notified(
    val closed: Boolean = false,
    val rang: Boolean = false,
    val waitingAt: String? = null,
    val waiting: String? = null,
    val back: String? = null,
)

/** A push about the question, as the phone opened it. */
internal sealed interface NotifyEvent {
    data object Asked : NotifyEvent
    data object Closed : NotifyEvent
    data class Flip(val at: String, val state: String) : NotifyEvent
    data class Return(val at: String, val due: Boolean) : NotifyEvent
}

/** What the push does: show the question with a sound, update it without one, or nothing. */
internal enum class NotifyEffect { Ring, Quiet, None }

/** Applies [event] to [kept]: what the phone remembers next, and what its notification does. */
internal fun notifyStep(kept: Notified, event: NotifyEvent): Pair<Notified, NotifyEffect> = when {
    event is NotifyEvent.Closed -> kept.copy(closed = true) to NotifyEffect.None
    kept.closed -> kept to NotifyEffect.None
    event is NotifyEvent.Asked -> if (kept.rang) kept to NotifyEffect.None else kept.copy(rang = true) to NotifyEffect.Ring
    event is NotifyEvent.Flip -> when {
        // The same flip again, or one older than the last applied, changes nothing.
        !laterWaiting(kept.waitingAt, kept.waiting, event.at, event.state) -> kept to NotifyEffect.None
        // Its first push is a flip: the owner has not heard of the question yet.
        !kept.rang -> kept.copy(rang = true, waitingAt = event.at, waiting = event.state) to NotifyEffect.Ring
        else -> kept.copy(waitingAt = event.at, waiting = event.state) to
            if (event.state == "waiting" && kept.waiting != "waiting") NotifyEffect.Ring else NotifyEffect.Quiet
    }
    // Its return rings once, and an older snooze's return, after a newer one's, not at all.
    event is NotifyEvent.Return -> if (!event.due || (kept.back != null && instant(event.at)?.isAfter(instant(kept.back) ?: Instant.MAX) != true)) kept to NotifyEffect.None
        else kept.copy(back = event.at, rang = true) to NotifyEffect.Ring
    else -> kept to NotifyEffect.None
}

/** How many questions [Saved.notified] keeps. */
const val NOTIFIED_MAX = 300

/**
 * [Saved] after a push about question [id], and what its notification does. [known] is the
 * question as this phone kept it before the push, when it did: what syncs read of it counts too.
 */
internal fun Saved.notifying(id: String, event: NotifyEvent, known: SavedDecision? = null): Pair<Saved, NotifyEffect> {
    var remembered = notified[id] ?: Notified()
    // A question a sync listed was in the inbox: a push about it is not the first the owner hears.
    if (known != null) remembered = remembered.copy(rang = true)
    // A flip a sync read, never pushed, counts as the last one applied: it is verified, and
    // later than what the pushes left.
    val at = known?.waitingAt
    val state = known?.waiting
    if (at != null && state != null && laterWaiting(remembered.waitingAt, remembered.waiting, at, state)) {
        remembered = remembered.copy(waitingAt = at, waiting = state)
    }
    val (kept, effect) = notifyStep(remembered, event)
    val next = notified - id + (id to kept)
    return copy(notified = next.entries.toList().takeLast(NOTIFIED_MAX).associate { it.key to it.value }) to effect
}

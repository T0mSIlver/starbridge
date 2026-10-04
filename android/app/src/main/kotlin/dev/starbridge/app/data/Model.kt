package dev.starbridge.app.data

import java.time.Instant

// The shapes the clients render. They follow SPEC.md for now; once
// packages/protocol (#1) lands, they mirror its zod schemas.

/** Which session asked. */
data class Source(val machine: String, val project: String, val session: String)

/**
 * A question an agent needs the owner to answer. [options] is empty for a
 * free-text answer; [default] says what the agent does if nobody answers, and when.
 */
data class Decision(
    val id: String,
    val question: String,
    val context: String,
    val options: List<String>,
    val recommended: String?,
    val default: String,
    val source: Source,
    val askedAt: Instant,
    val answer: String? = null,
    val answeredAt: Instant? = null,
)

/** Where a window is headed by its reset, as the uploader computes it. */
sealed interface Pace {
    data object Even : Pace
    data class RunsOut(val at: Instant) : Pace
    data class Unused(val percent: Int) : Pace
}

/** One quota window of one AI plan; [alert] is set when it resets soon with headroom unused. */
data class QuotaWindow(
    val id: String,
    val provider: String,
    val window: String,
    val usedPercent: Int,
    val resetsAt: Instant,
    val pace: Pace,
    val alert: Boolean = false,
)

enum class Kind { Phone, Browser, Machine }

/** An entry in the account's key directory: a device (phone, browser) or a machine where agents run. */
data class Member(
    val id: String,
    val name: String,
    val kind: Kind,
    val addedAt: Instant,
    val current: Boolean = false,
)

/** A machine asking to join, with the code its CLI prints. */
data class Pairing(val id: String, val machine: String, val code: String, val requestedAt: Instant)

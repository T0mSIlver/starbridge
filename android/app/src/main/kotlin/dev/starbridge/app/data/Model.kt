package dev.starbridge.app.data

import java.time.Instant

// The shapes the screens render, made from verified protocol bodies (protocol/Schemas.kt).

/** Which session asked; [links] open it in the Claude app or a browser (kinds as in the protocol). */
data class Source(
    val machine: String,
    val project: String,
    val session: String,
    val title: String? = null,
    val links: List<SessionLink> = emptyList(),
)

data class SessionLink(val kind: String, val url: String)

/**
 * A question an agent needs the owner to answer. [options] is empty for a free-text answer;
 * [default] says what the agent does if nobody answers, by [defaultAt] when set.
 */
data class Decision(
    val id: String,
    val question: String,
    val context: String,
    val options: List<String>,
    val recommended: String?,
    val default: String,
    val defaultAt: Instant?,
    val source: Source,
    val createdAt: Instant,
    /** This device's answer; null when it was answered elsewhere or is still open. */
    val answer: String? = null,
    val answeredAt: Instant? = null,
) {
    val open get() = answeredAt == null && answer == null
}

/** Where a window is headed by its reset, as the uploader computed it. */
sealed interface Pace {
    data object Even : Pace
    data class RunsOut(val at: Instant) : Pace
    data class Unused(val percent: Int) : Pace
    /** Too early in the window to tell. */
    data object Unknown : Pace
}

/** One quota window of one AI plan; [alert] is set when the uploader raised an alert for it. */
data class QuotaWindow(
    val id: String,
    val provider: String,
    val window: String,
    val usedPercent: Int,
    val resetsAt: Instant?,
    val pace: Pace,
    val alert: Boolean = false,
)

enum class Kind { Device, Machine }

/** An active member of the account's directory: a device (phone, browser) or a machine. */
data class Member(
    val id: String,
    val name: String,
    val kind: Kind,
    val addedAt: Instant,
    val current: Boolean = false,
)

/** What approving a pairing code has reached. */
sealed interface Approval {
    data object Idle : Approval
    data object Checking : Approval
    /** The code's request checked out: who asks to join, to show before approving. */
    data class Found(val name: String, val kind: Kind, val code: String) : Approval
    data class Approving(val found: Found) : Approval
    data class Done(val name: String) : Approval
    data class Failed(val message: String) : Approval
}

/** Where this phone is in setting up. */
sealed interface Phase {
    data object SignedOut : Phase
    /** Signed in but not in the directory yet. [accountExists]: another device set it up. */
    data class NoDevice(val accountExists: Boolean) : Phase
    /** Waiting for another device to approve this one; it shows [code]. */
    data class Joining(val code: String) : Phase
    /** The first device shows the recovery words once. */
    data class RecoveryKey(val words: List<String>) : Phase
    data object Ready : Phase
}

/** How pushes reach this phone. */
data class PushSetting(val type: String, val fcmAvailable: Boolean, val distributors: List<String>, val registered: Boolean)

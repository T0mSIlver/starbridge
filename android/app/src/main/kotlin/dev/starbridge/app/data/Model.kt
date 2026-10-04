package dev.starbridge.app.data

import dev.starbridge.app.protocol.RUN_STALE_MS
import java.time.Duration
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

/** A wider allow a prompt offers: "session" or "project", its label and the exact rule it adds. */
data class PromptScope(val scope: String, val label: String, val rule: String)

/**
 * An agent waiting at a permission prompt (#57). [input] is the tool's input as JSON text,
 * redacted on the machine. [ended] says how it ended once it did ("Answered on devbox").
 */
data class Prompt(
    val id: String,
    val tool: String,
    val summary: String,
    val description: String?,
    val input: String,
    val scopes: List<PromptScope>,
    val source: Source,
    val createdAt: Instant,
    val expiresAt: Instant,
    val ended: String? = null,
    val endedAt: Instant? = null,
) {
    fun waiting(now: Instant) = ended == null && now.isBefore(expiresAt)
}

/**
 * A command an agent wrapped in `starbridge run` because one of the owner's rules named it, as
 * its latest update says. [exitCode] and [endedAt] are set once it exited.
 */
data class Run(
    val id: String,
    val title: String,
    /** Why the owner hears of it, e.g. "uses your session and keyboard". */
    val reason: String,
    val source: Source,
    val startedAt: Instant,
    /** When the machine sent this update. */
    val at: Instant,
    val progress: Progress? = null,
    val exitCode: Int? = null,
    val endedAt: Instant? = null,
) {
    /** The last progress the output printed: steps such as 3/7, or a percent. */
    data class Progress(val done: Int, val total: Int, val percent: Boolean) {
        val fraction get() = done.toFloat() / total
        val text get() = if (percent) "$done%" else "$done/$total"
    }

    enum class State { Running, Passed, Failed, Lost }

    /** Running until it exits; lost once its machine is quiet for RUN_STALE_MS. */
    fun state(now: Instant): State = when {
        exitCode == 0 -> State.Passed
        exitCode != null -> State.Failed
        Duration.between(at, now).toMillis() > RUN_STALE_MS -> State.Lost
        else -> State.Running
    }

    /** When the last news came: the exit, else the last update. */
    val lastNews get() = endedAt ?: at

    companion object {
        /** A finished or lost run stays on the screen this long, so its result is seen. */
        val SHOWN_AFTER: Duration = Duration.ofMinutes(30)

        /** Running runs, newest first, then the others still shown, latest news first. */
        fun shown(runs: List<Run>, now: Instant): List<Run> {
            val running = runs.filter { it.state(now) == State.Running }.sortedByDescending { it.startedAt }
            val done = runs
                .filter { it.state(now) != State.Running && Duration.between(it.lastNews, now) <= SHOWN_AFTER }
                .sortedByDescending { it.lastNews }
            return running + done
        }
    }
}

/** Where a window is headed by its reset, as the uploader computed it. */
sealed interface Pace {
    data object Even : Pace
    data class RunsOut(val at: Instant) : Pace
    data class Unused(val percent: Int) : Pace
    /** Too early in the window to tell. */
    data object Unknown : Pace
}

/**
 * One quota window of one AI plan. [steadyPercent] is where a steady pace would be now, when the
 * uploader knows; [alert] is set when it raised an alert for the window.
 */
data class QuotaWindow(
    val id: String,
    val provider: String,
    val window: String,
    val usedPercent: Int,
    val resetsAt: Instant?,
    val pace: Pace,
    val alert: Boolean = false,
    val steadyPercent: Int? = null,
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
    /** This phone shows a QR code (a pairing link) and waits for a new phone to scan it. */
    data class Showing(val code: String, val link: String) : Approval
    data class Done(val name: String) : Approval
    data class Failed(val message: String) : Approval
}

/** Where this phone is in setting up. */
sealed interface Phase {
    data object SignedOut : Phase
    /** Signed in but not in the directory yet. [accountExists]: another device set it up. */
    data class NoDevice(val accountExists: Boolean) : Phase
    /** Waiting for another device to approve this one; it shows [code], or [scanned] it. */
    data class Joining(val code: String, val scanned: Boolean = false) : Phase
    /** Asked the account's devices to approve this one; [digits] once one of them took it. */
    data class JoiningByDigits(val digits: String?) : Phase
    /** The first device shows the recovery words once. */
    data class RecoveryKey(val words: List<String>) : Phase
    data object Ready : Phase
}

/** How pushes reach this phone. */
data class PushSetting(val type: String, val fcmAvailable: Boolean, val distributors: List<String>, val registered: Boolean)

/** A browser or phone signed in to the account that asks to join; [elsewhere] when another device compares digits for it. */
data class JoinAsk(val id: String, val name: String, val at: Instant, val elsewhere: Boolean)

/** Comparing digits for a join request, on this phone. */
sealed interface Comparison {
    data object Idle : Comparison
    data class Waiting(val ask: JoinAsk) : Comparison
    /** [error]: the last approval failed on the way and can be retried. */
    data class Digits(val ask: JoinAsk, val digits: String, val approving: Boolean = false, val error: String? = null) : Comparison
    data class Done(val message: String) : Comparison
    data class Failed(val message: String) : Comparison
}

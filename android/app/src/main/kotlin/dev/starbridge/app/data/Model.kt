package dev.starbridge.app.data

import dev.starbridge.app.protocol.RUN_STALE_MS
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    /** server, desktop, laptop or cloud; null from machines that predate it. */
    val machineKind: String? = null,
)

data class SessionLink(val kind: String, val url: String)

/** An image the agent attached: a PNG or JPEG, base64url in [data], [width] by [height] pixels. */
data class Image(val data: String, val width: Int, val height: Int, val alt: String? = null)

/** A page the agent attached, such as a Claude artifact. */
data class Link(val url: String, val title: String? = null)

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
    val default: String?,
    val defaultAt: Instant?,
    val source: Source,
    val createdAt: Instant,
    /** claude-code or codex, when the machine says. */
    val agent: String? = null,
    /** The agent is blocked on it, rather than working on other things. */
    val waiting: Boolean = false,
    /** When the agent last flipped to waiting. */
    val waitingSince: Instant? = null,
    val images: List<Image> = emptyList(),
    val links: List<Link> = emptyList(),
    /** The page the owner answers on instead of here, such as a Claude artifact. */
    val answerIn: Link? = null,
    /** This device's answer; null when it was answered elsewhere or is still open. */
    val answer: String? = null,
    val answeredAt: Instant? = null,
    /** How the machine closed it, when its settled notice did: "withdrawn" or "elsewhere". */
    val settled: String? = null,
    /** The machine takes a typed reply in place of an option (#201). */
    val replies: Boolean = false,
) {
    /**
     * Waiting for the owner. A decision answered on another page also stops waiting at its default
     * time: no answer reaches Starbridge, and the agent applies its default then.
     */
    fun isOpen(now: Instant) = answeredAt == null && answer == null && !lapsed(now)

    /**
     * The agent's proposal, shown as "Default": the option it named, else its first (#191). Never
     * applied for the owner; nothing happens until the owner answers.
     */
    val proposal: String? get() = recommended ?: options.firstOrNull()

    /** The options, the proposal first. */
    val ordered: List<String> get() = options.sortedByDescending { it == proposal }

    /** Answered elsewhere, and its default time passed before the agent settled it. */
    fun lapsed(now: Instant) = answerIn != null && answeredAt == null && defaultAt?.let { !it.isAfter(now) } == true
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
    val agent: String? = null,
    val ended: String? = null,
    val endedAt: Instant? = null,
) {
    fun waiting(now: Instant) = ended == null && now.isBefore(expiresAt)

    /**
     * The input as the owner reads it before allowing, as on the web (#276): a command's full
     * text, then its other fields but the description as indented JSON; any other input as
     * indented JSON. [summary] is capped at 200 characters, so a command's tail can hide past it.
     */
    val fullInput: String by lazy { visible(readable(input).ifEmpty { summary }) }

    /** Whether the whole input fits one line of a card or a notification, so it may carry Allow (#356). */
    val fitsRow: Boolean get() = fullInput.length <= ROW_INPUT_MAX && '\n' !in fullInput
}

/** The longest input a card or a notification shows whole, and so the longest it may carry Allow for. */
const val ROW_INPUT_MAX = 200

private val pretty = Json { prettyPrint = true }

/** JSON [input] indented, a command first in its own words; other input as it came. */
fun readable(input: String): String {
    val parsed = runCatching { Json.parseToJsonElement(input) }.getOrElse { return input }
    val command = ((parsed as? JsonObject)?.get("command") as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (command == null) return pretty.encodeToString(JsonElement.serializer(), parsed)
    val rest = JsonObject((parsed as JsonObject) - "command" - "description")
    return if (rest.isEmpty()) command else "$command\n\n${pretty.encodeToString(JsonElement.serializer(), rest)}"
}

/** Control and format characters but newline and tab: bidi overrides, isolates, zero-widths. */
private val INVISIBLE = Regex("[\\p{Cc}\\p{Cf}\\u2028\\u2029&&[^\\n\\t]]")

/**
 * [text] with each control or format character shown as its escape (`\u202E`), so a prompt reads
 * in the order it runs: a bidi override cannot reorder what the owner allows (#357).
 */
fun visible(text: String): String = INVISIBLE.replace(text) {
    val c = it.value.codePointAt(0)
    if (c > 0xFFFF) "\\u{%X}".format(c) else "\\u%04X".format(c)
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
    /** The uploading machine's name, set when more than one machine uploads quotas. */
    val machine: String? = null,
    val windowMinutes: Int? = null,
    /** When the uploader took the snapshot this window comes from. */
    val takenAt: Instant? = null,
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
    /**
     * Asked the account's devices to approve this one; [digits] once one of them took it, and
     * [matched] once the owner said that device shows the same digits.
     */
    data class JoiningByDigits(val digits: String?, val matched: Boolean = false) : Phase
    /** The first device shows the recovery key once. */
    /** [shown]: a recovery key, or an older account's words. */
    data class RecoveryKey(val shown: String) : Phase
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

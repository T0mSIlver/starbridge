package dev.starbridge.app.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// The Kotlin side of packages/protocol/src/schemas.ts. Each type parses with kotlinx and then
// checks what zod checks there; a failure is `bad-schema`. Unknown keys are ignored, as zod
// strips them.

val ProtocolJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

const val RECOVERY = "recovery"

private val B64_RE = Regex("^[A-Za-z0-9_-]+$")
private val ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
// zod's iso.datetime({ offset: true }).
private val TIME_RE = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$""")

internal fun schema(ok: Boolean, what: String) {
    if (!ok) throw ProtocolException("bad-schema", what)
}

internal fun b64(s: String, what: String) = schema(B64_RE.matches(s), what)
internal fun id(s: String, what: String) = schema(ID_RE.matches(s), what)
internal fun time(s: String, what: String) = schema(TIME_RE.matches(s), what)
internal fun len(s: String, min: Int, max: Int, what: String) = schema(s.length in min..max, what)

fun <T> parseJson(serializer: KSerializer<T>, element: JsonElement): T = try {
    ProtocolJson.decodeFromJsonElement(serializer, element)
} catch (e: SerializationException) {
    throw ProtocolException("bad-schema", e.message?.lineSequence()?.firstOrNull())
} catch (e: IllegalArgumentException) {
    throw ProtocolException("bad-schema", e.message?.lineSequence()?.firstOrNull())
}

fun parseJsonText(text: String): JsonElement = try {
    ProtocolJson.parseToJsonElement(text)
} catch (e: SerializationException) {
    throw ProtocolException("bad-schema", "not JSON")
}

// --- Directory ---------------------------------------------------------------

@Serializable
data class Member(val id: String, val role: String, val name: String, val boxPk: String, val signPk: String) {
    fun check() {
        id(id, "member id")
        schema(role == "device" || role == "machine", "role")
        len(name, 1, 100, "name")
        b64(boxPk, "boxPk")
        b64(signPk, "signPk")
    }
}

/** An add or revoke entry: `member` and `recoveryPk` on add, `id` on revoke. */
@Serializable
data class DirectoryEntry(
    val v: Int,
    val account: String,
    val seq: Int,
    val prev: String?,
    val at: String,
    val op: String,
    val member: Member? = null,
    val recoveryPk: String? = null,
    val id: String? = null,
) {
    fun check() {
        schema(v == 1, "v")
        id(account, "account")
        schema(seq >= 0, "seq")
        prev?.let { b64(it, "prev") }
        time(at, "at")
        when (op) {
            "add" -> {
                schema(member != null, "member")
                member!!.check()
                recoveryPk?.let { b64(it, "recoveryPk") }
            }
            "revoke" -> {
                schema(id != null, "id")
                id(id!!, "id")
            }
            else -> schema(false, "op")
        }
    }
}

// --- Signed and sealed envelopes ---------------------------------------------

/** ITEM_KINDS in schemas.ts: the role that signs each sealed kind. */
val SIGNER_ROLE = mapOf(
    "decision" to "machine",
    "answer" to "device",
    "quota" to "machine",
    "permission" to "machine",
    "permission-answer" to "device",
    "settled" to "machine",
    "run" to "machine",
)
val ITEM_KINDS = SIGNER_ROLE.keys
val KINDS = setOf("directory") + ITEM_KINDS

/** A sealed item's body: its id, the item its `re` hint names, and the members it is sealed to. */
interface ItemBody {
    val id: String
    val re: String? get() = null
    val recipients: List<String>
}

/** `body` is the JSON text exactly as signed; verifiers check the signature before parsing it. */
@Serializable
data class SignedEnvelope(
    val v: Int,
    val kind: String,
    val signer: String,
    val body: String,
    val sig: String,
    val recoverySig: String? = null,
) {
    fun check() {
        schema(v == 1, "v")
        schema(kind in KINDS, "kind")
        id(signer, "signer")
        b64(sig, "sig")
        recoverySig?.let { b64(it, "recoverySig") }
    }
}

@Serializable
data class SealedBox(val to: String, val box: String)

/** What the server stores and relays; `kind`, `id`, `from`, `re` and `to` are routing hints. */
@Serializable
data class SealedItem(
    val v: Int,
    val kind: String,
    val id: String,
    val from: String,
    val re: String? = null,
    val boxes: List<SealedBox>,
) {
    fun check() {
        schema(v == 1, "v")
        schema(kind in ITEM_KINDS, "kind")
        id(id, "id")
        id(from, "from")
        re?.let { id(it, "re") }
        schema(boxes.size in 1..64, "boxes")
        for (b in boxes) {
            id(b.to, "to")
            b64(b.box, "box")
        }
    }
}

// --- Decisions and answers ---------------------------------------------------

@Serializable
data class DecisionDefault(val action: String, val at: String? = null)

/** Each link kind's URL prefix (SESSION_LINK_PREFIX in schemas.ts). */
val SESSION_LINK_PREFIX = mapOf(
    "remote-control" to "https://claude.ai/code/",
    "web" to "https://claude.ai/code/",
    "desktop" to "claude://claude.ai/",
)
private val LINK_URL_RE = Regex("^[\\x21-\\x7e]+$")

@Serializable
data class SessionLink(val kind: String, val url: String)

@Serializable
data class Source(
    val machine: String,
    val project: String,
    val session: String,
    val sessionTitle: String? = null,
    val links: List<SessionLink>? = null,
) {
    fun check() {
        len(machine, 1, 100, "source.machine")
        len(project, 0, 200, "source.project")
        len(session, 0, 200, "source.session")
        sessionTitle?.let { len(it, 0, 200, "source.sessionTitle") }
        links?.let { links ->
            schema(links.size <= 3, "source.links")
            for (l in links) {
                val prefix = SESSION_LINK_PREFIX[l.kind]
                schema(prefix != null, "source.links.kind")
                schema(l.url.length <= 2048 && LINK_URL_RE.matches(l.url), "source.links.url")
                schema(l.url.startsWith(prefix!!), "url does not match its kind")
            }
        }
    }
}

/** PNG or JPEG only: never SVG, which can carry script (DecisionImage in schemas.ts). */
val IMAGE_TYPES = setOf("image/png", "image/jpeg")
private val HTTPS_URL_RE = Regex("^https://[\\x21-\\x7e]+$")

@Serializable
data class DecisionImage(
    val type: String,
    val width: Int,
    val height: Int,
    val data: String,
    val alt: String? = null,
) {
    fun check() {
        schema(type in IMAGE_TYPES, "images.type")
        schema(width in 1..8192 && height in 1..8192, "images.size")
        schema(data.length <= 256 * 1024, "images.data")
        b64(data, "images.data")
        alt?.let { len(it, 0, 300, "images.alt") }
    }
}

/** A page to open, typically a claude.ai artifact; HTTPS only (DecisionLink in schemas.ts). */
@Serializable
data class DecisionLink(val url: String, val title: String? = null) {
    fun check() {
        schema(url.length <= 2048 && HTTPS_URL_RE.matches(url), "links.url")
        title?.let { len(it, 1, 100, "links.title") }
    }
}

@Serializable
data class Decision(
    val v: Int,
    override val id: String,
    val to: List<String>,
    val createdAt: String,
    val question: String,
    val context: String,
    val options: List<String>,
    val recommended: String? = null,
    @SerialName("default") val fallback: DecisionDefault,
    val source: Source,
    val images: List<DecisionImage>? = null,
    val links: List<DecisionLink>? = null,
    /** The page the owner answers on instead of Starbridge (answerIn in schemas.ts). */
    val answerIn: DecisionLink? = null,
) : ItemBody {
    override val recipients get() = to

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        schema(to.isNotEmpty(), "to")
        to.forEach { id(it, "to") }
        time(createdAt, "createdAt")
        len(question, 1, 300, "question")
        len(context, 0, 8000, "context")
        schema(options.size <= 4, "options")
        options.forEach { len(it, 1, 100, "option") }
        len(fallback.action, 1, 300, "default.action")
        fallback.at?.let { time(it, "default.at") }
        source.check()
        images?.let { schema(it.size <= 4, "images"); it.forEach(DecisionImage::check) }
        links?.let { schema(it.size <= 4, "links"); it.forEach(DecisionLink::check) }
        answerIn?.let {
            it.check()
            schema(options.isEmpty(), "a decision answered elsewhere has no options")
        }
        schema(options.size != 1, "options: 0 or 2 to 4")
        schema(options.toSet().size == options.size, "options must be distinct")
        if (options.isNotEmpty()) schema(recommended != null && recommended in options, "recommended must be one of the options")
        else schema(recommended == null, "recommended needs options")
    }
}

@Serializable
data class Answer(
    val v: Int,
    override val id: String,
    val decisionId: String,
    val to: String,
    val answeredAt: String,
    val choice: String? = null,
    val text: String? = null,
) : ItemBody {
    override val re get() = decisionId
    override val recipients get() = listOf(to)

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        id(decisionId, "decisionId")
        id(to, "to")
        time(answeredAt, "answeredAt")
        choice?.let { len(it, 0, 100, "choice") }
        text?.let { len(it, 0, 4000, "text") }
        schema((choice == null) != (text == null), "exactly one of choice and text")
    }
}

// --- Permission prompts -----------------------------------------------------

/** PERMISSION_TTL_MS in schemas.ts. */
const val PERMISSION_TTL_MS = 10 * 60 * 1000L

private fun instantOf(s: String): java.time.Instant {
    // TIME_RE allows a missing seconds field and an offset without a colon; java.time does not.
    val m = Regex("""^(.{16})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}):?(\d{2})?$""").matchEntire(s)
        ?: throw ProtocolException("bad-schema", "time")
    val (head, secs, _, zone, zoneMin) = m.destructured
    val offset = if (zone == "Z") "Z" else "$zone:$zoneMin"
    return try {
        java.time.OffsetDateTime.parse(head + secs.ifEmpty { ":00" } + offset).toInstant()
    } catch (e: java.time.format.DateTimeParseException) {
        throw ProtocolException("bad-schema", "time")
    }
}

@Serializable
data class PermissionSuggestion(val label: String, val rule: String, val scope: String)

@Serializable
data class Permission(
    val v: Int,
    override val id: String,
    val to: List<String>,
    val createdAt: String,
    val agent: String,
    val tool: String,
    val summary: String,
    val description: String? = null,
    val input: String,
    val inputHash: String,
    val suggestions: List<PermissionSuggestion>,
    val expiresAt: String,
    val source: Source,
) : ItemBody {
    override val recipients get() = to

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        schema(to.isNotEmpty(), "to")
        to.forEach { id(it, "to") }
        time(createdAt, "createdAt")
        schema(agent in setOf("claude-code", "codex"), "agent")
        len(tool, 1, 100, "tool")
        len(summary, 1, 200, "summary")
        description?.let { len(it, 0, 500, "description") }
        len(input, 0, 8000, "input")
        b64(inputHash, "inputHash")
        schema(suggestions.size <= 2, "suggestions")
        for (x in suggestions) {
            len(x.label, 1, 100, "suggestion label")
            len(x.rule, 1, 500, "suggestion rule")
            schema(x.scope == "session" || x.scope == "project", "suggestion scope")
        }
        time(expiresAt, "expiresAt")
        source.check()
        val ttl = instantOf(expiresAt).toEpochMilli() - instantOf(createdAt).toEpochMilli()
        schema(ttl > 0 && ttl <= PERMISSION_TTL_MS, "expiresAt: after createdAt, at most 10 minutes")
        schema(suggestions.map { it.scope }.toSet().size == suggestions.size, "one suggestion per scope")
    }
}

@Serializable
data class PermissionAnswer(
    val v: Int,
    override val id: String,
    val permissionId: String,
    val to: String,
    val answeredAt: String,
    val behavior: String,
    val scope: String,
    val inputHash: String,
    val message: String? = null,
) : ItemBody {
    override val re get() = permissionId
    override val recipients get() = listOf(to)

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        id(permissionId, "permissionId")
        id(to, "to")
        time(answeredAt, "answeredAt")
        schema(behavior == "allow" || behavior == "deny", "behavior")
        schema(scope in setOf("once", "session", "project"), "scope")
        b64(inputHash, "inputHash")
        message?.let { len(it, 0, 500, "message") }
        if (behavior == "deny") schema(scope == "once", "a deny is for this call only")
        else schema(message == null, "message is for a deny")
    }
}

@Serializable
data class Settled(
    val v: Int,
    override val id: String,
    val itemId: String,
    val to: List<String>,
    val at: String,
    val outcome: String? = null,
    val device: String? = null,
) : ItemBody {
    override val re get() = itemId
    override val recipients get() = to

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        id(itemId, "itemId")
        schema(to.isNotEmpty(), "to")
        to.forEach { id(it, "to") }
        outcome?.let { schema(it in setOf("keyboard", "timeout", "device", "elsewhere", "withdrawn"), "outcome") }
        device?.let { id(it, "device") }
        time(at, "at")
        schema((outcome == "device") == (device != null), "device is set exactly when outcome is device")
    }
}

// --- Runs --------------------------------------------------------------------

/** RUN_HEARTBEAT_MS and RUN_STALE_MS in schemas.ts. */
const val RUN_HEARTBEAT_MS = 60_000L
const val RUN_STALE_MS = 3 * RUN_HEARTBEAT_MS

@Serializable
data class RunProgress(val done: Int, val total: Int, val unit: String)

@Serializable
data class RunExit(val code: Int, val at: String)

/** A command an agent wrapped in `starbridge run`, re-posted under its id as it changes. */
@Serializable
data class Run(
    val v: Int,
    override val id: String,
    val to: List<String>,
    val title: String,
    val reason: String,
    val source: Source,
    val startedAt: String,
    val at: String,
    val progress: RunProgress? = null,
    val exit: RunExit? = null,
) : ItemBody {
    override val recipients get() = to

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        schema(to.isNotEmpty(), "to")
        to.forEach { id(it, "to") }
        len(title, 1, 100, "title")
        len(reason, 1, 200, "reason")
        source.check()
        time(startedAt, "startedAt")
        time(at, "at")
        val started = instantOf(startedAt)
        schema(!instantOf(at).isBefore(started), "at: not before startedAt")
        progress?.let { p ->
            schema(p.unit in setOf("step", "percent"), "progress.unit")
            schema(p.total >= 1 && p.done in 0..p.total, "done is at most total")
            schema(p.unit == "step" || p.total == 100, "a percent is out of 100")
        }
        exit?.let { e ->
            schema(e.code in 0..255, "exit.code")
            time(e.at, "exit.at")
            schema(!instantOf(e.at).isBefore(started), "exit.at: not before startedAt")
        }
    }
}

// --- Quotas ------------------------------------------------------------------

@Serializable
data class Pace(
    val stage: String,
    val expectedUsedPercent: Double,
    val deltaPercent: Double,
    val projectedUsedPercent: Double?,
    val willLastToReset: Boolean,
    val runsOutAt: String?,
)

@Serializable
data class QuotaWindow(
    val id: String,
    val label: String,
    val usedPercent: Double,
    val windowMinutes: Int?,
    val resetsAt: String?,
    val pace: Pace?,
)

@Serializable
data class QuotaAlert(
    val kind: String,
    val provider: String,
    val window: String,
    val resetsAt: String,
    val unusedPercent: Double? = null,
    val runsOutAt: String? = null,
    /** "low": at most this percent left. */
    val threshold: Int? = null,
    /** Set in the one snapshot that first raised it: the one that asked for a push. */
    val notify: Boolean? = null,
)

@Serializable
data class QuotaProvider(
    val provider: String,
    val account: String? = null,
    val windows: List<QuotaWindow>,
    val error: String? = null,
)

@Serializable
data class QuotaSnapshot(
    val v: Int,
    override val id: String,
    val to: List<String>,
    val takenAt: String,
    val providers: List<QuotaProvider>,
    val alerts: List<QuotaAlert>,
) : ItemBody {
    override val recipients get() = to

    fun check() {
        schema(v == 1, "v")
        id(id, "id")
        schema(to.isNotEmpty(), "to")
        to.forEach { id(it, "to") }
        time(takenAt, "takenAt")
        for (p in providers) {
            len(p.provider, 1, 100, "provider")
            for (w in p.windows) {
                len(w.id, 1, 100, "window id")
                schema(w.usedPercent >= 0, "usedPercent")
                w.windowMinutes?.let { schema(it > 0, "windowMinutes") }
                w.resetsAt?.let { time(it, "resetsAt") }
                w.pace?.let { pace ->
                    schema(pace.stage in setOf("ahead", "on-track", "behind", "unknown"), "pace.stage")
                    pace.runsOutAt?.let { time(it, "runsOutAt") }
                }
            }
        }
        for (a in alerts) {
            time(a.resetsAt, "alert resetsAt")
            when (a.kind) {
                "unused-headroom" -> schema(a.unusedPercent != null, "unusedPercent")
                "runs-out" -> schema(a.runsOutAt?.let { time(it, "runsOutAt"); true } == true, "runsOutAt")
                "low" -> schema(a.threshold in 1..99, "threshold")
                else -> schema(false, "alert kind")
            }
        }
    }
}

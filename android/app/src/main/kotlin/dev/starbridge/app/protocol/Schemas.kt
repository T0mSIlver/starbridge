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

val KINDS = setOf("directory", "decision", "answer", "quota")
val ITEM_KINDS = setOf("decision", "answer", "quota")

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
data class DecisionSource(
    val machine: String,
    val project: String,
    val session: String,
    val sessionTitle: String? = null,
    val links: List<SessionLink>? = null,
)

@Serializable
data class Decision(
    val v: Int,
    val id: String,
    val to: List<String>,
    val createdAt: String,
    val question: String,
    val context: String,
    val options: List<String>,
    val recommended: String? = null,
    @SerialName("default") val fallback: DecisionDefault,
    val source: DecisionSource,
) {
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
        len(source.machine, 1, 100, "source.machine")
        len(source.project, 0, 200, "source.project")
        len(source.session, 0, 200, "source.session")
        source.sessionTitle?.let { len(it, 0, 200, "source.sessionTitle") }
        source.links?.let { links ->
            schema(links.size <= 3, "source.links")
            for (l in links) {
                val prefix = SESSION_LINK_PREFIX[l.kind]
                schema(prefix != null, "source.links.kind")
                schema(l.url.length <= 2048 && LINK_URL_RE.matches(l.url), "source.links.url")
                schema(l.url.startsWith(prefix!!), "url does not match its kind")
            }
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
    val id: String,
    val decisionId: String,
    val to: String,
    val answeredAt: String,
    val choice: String? = null,
    val text: String? = null,
) {
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
    val id: String,
    val to: List<String>,
    val takenAt: String,
    val providers: List<QuotaProvider>,
    val alerts: List<QuotaAlert>,
) {
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
                else -> schema(false, "alert kind")
            }
        }
    }
}

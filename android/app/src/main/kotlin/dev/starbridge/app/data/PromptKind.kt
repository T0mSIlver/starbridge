package dev.starbridge.app.data

import dev.starbridge.app.protocol.Retention
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.Settled
import dev.starbridge.app.protocol.takeCodePoints
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Permission prompts: a machine's tool call that waits for Allow or Deny, and the settled notices
 * that end them. A notice about no prompt goes to [settleDecision].
 */
internal class PromptKind(
    private val core: Core,
    private val settleDecision: (id: String, from: String, notice: Settled) -> Unit,
) : ItemKind {
    override val pushes = setOf("permission", "settled")
    val shown = MutableStateFlow<List<Prompt>>(emptyList())

    private val saved get() = core.saved
    private val alerts get() = core.alerts
    private val directory get() = core.directory
    private val me get() = core.me
    private val lock get() = core.lock
    private fun persist(newSaved: Saved) = core.persist(newSaved)
    private fun api() = core.api()
    private val phase get() = core.phase
    private val envelopes get() = core.envelopes
    private val signKey get() = core.signKey
    private fun open(item: SealedItem) = core.open(item)
    private suspend fun scan(items: List<SealedItem>) = core.scan(items)
    private fun withheld() = core.withheld()
    private fun describe(e: Exception) = core.describe(e)
    private fun newId(prefix: String) = core.newId(prefix)
    private fun now() = core.now()
    private fun run(showBusy: Boolean = true, sync: Boolean = false, block: suspend () -> Unit) = core.run(showBusy, sync, block)

    override fun publish(view: View) {
        shown.value = if (view.held) emptyList() else saved.prompts.filter { view.active(it.from) }.map(::toUi)
    }

    override fun revoked(dir: dev.starbridge.app.protocol.Directory) {
        for (p in saved.prompts) if (dir.members[p.from]?.active == false) alerts.cancelPrompt(toUi(p))
    }

    /** An `answered` push: closes the prompt's notification; false when [id] is no prompt here. */
    fun cancelNotification(id: String): Boolean {
        val prompt = saved.prompts.find { it.body.id == id } ?: return false
        alerts.cancelPrompt(toUi(prompt))
        return true
    }

    /**
     * Reads permission prompts and settled notices past the cursor. A prompt comes again once it
     * is answered or settled, with its time; a notice counts only from the machine that asked.
     */
    override suspend fun sync() {
        var cursor = saved.promptCursor
        val byId = saved.prompts.associateBy { it.body.id }.toMutableMap()
        val read = mutableListOf<Listed>()
        while (true) {
            val page = api().items("permission,settled", cursor)
            read += page.items
            cursor = page.cursor
            if (page.last) break
        }
        if (scan(read.map { it.item })) return
        // A settled prompt comes back after its notice, so prompts go first: a notice whose
        // prompt is new to this phone would otherwise find nothing to close.
        for (listed in read.sortedBy { if (it.item.kind == "permission") 0 else 1 }) take(listed.item, listed.answeredAt, byId)
        keep(byId, cursor)
    }

    /** Merges one verified prompt or notice into [byId]; clears the notification of one that ended. */
    private fun take(item: SealedItem, answeredAt: String?, byId: MutableMap<String, SavedPrompt>): SavedPrompt? {
        when (item.kind) {
            "permission" -> {
                val known = byId[item.id]
                if (known != null) {
                    if (answeredAt != null && known.answeredAt == null) {
                        byId[item.id] = known.copy(answeredAt = answeredAt)
                        alerts.cancelPrompt(toUi(known))
                    }
                    return null
                }
                val (from, _, text) = open(item) ?: return null
                return SavedPrompt(from, text, answeredAt).also { byId[item.id] = it }
            }
            "settled" -> {
                val (from, body, text) = open(item) ?: return null
                val notice = body as Settled
                val p = byId[notice.itemId]
                if (p == null) {
                    settleDecision(notice.itemId, from, notice)
                    return null
                }
                if (p.from != from) return null
                byId[p.body.id] = p.copy(settledText = text, answeredAt = p.answeredAt ?: notice.at)
                alerts.cancelPrompt(toUi(p))
            }
        }
        return null
    }

    override suspend fun onPush(kind: String, id: String, push: JsonObject) {
        if (kind == "permission" && saved.prompts.any { it.body.id == id }) return
        val (item, answeredAt) = core.pushed(kind, id, push)
        core.catchUp(item)
        val byId = saved.prompts.associateBy { it.body.id }.toMutableMap()
        val added = take(item, answeredAt, byId)
        keep(byId)
        if (added != null && added.answeredAt == null) alerts.prompt(toUi(added))
    }

    /** Keeps a week of prompts, the log's span, as the server does. */
    private fun keep(byId: Map<String, SavedPrompt>, cursor: String = saved.promptCursor) {
        val weekAgo = Instant.now().minus(Retention.WEEK, ChronoUnit.DAYS)
        val kept = byId.values.filter { instant(it.body.createdAt)?.isAfter(weekAgo) != false }.sortedBy { it.body.createdAt }
        persist(saved.copy(promptCursor = cursor, prompts = kept))
    }

    /**
     * The inbox's quick read while a prompt shows. After a failure (offline, say) it waits 3 s,
     * then twice as long after each further one, up to a minute, instead of retrying every 1.5 s.
     */
    fun refresh() {
        if (System.currentTimeMillis() < retryAt) return
        run(showBusy = false, sync = true) {
            if (phase.value != Phase.Ready) return@run
            try {
                sync()
                failures = 0
            } catch (e: Exception) {
                failures++
                retryAt = System.currentTimeMillis() + minOf(60_000L, 1_500L shl failures.coerceAtMost(6))
                throw e
            }
        }
    }

    @Volatile private var failures = 0
    @Volatile private var retryAt = 0L

    fun answer(id: String, allow: Boolean, scope: String, message: String?) =
        run(showBusy = false) { send(id, allow, scope, message) }

    /**
     * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
     * asked. A deny is for this call only; a wider allow only for a scope the prompt offered.
     */
    suspend fun send(id: String, allow: Boolean, scope: String, message: String?) {
        withheld()?.let { throw IllegalStateException(it) }
        val p = saved.prompts.find { it.body.id == id } ?: throw IllegalStateException("No such prompt.")
        if (p.answeredAt != null || p.answer != null) throw IllegalStateException("Already answered.")
        val chosen = if (allow) scope else "once"
        if (chosen != "once" && p.body.suggestions.none { it.scope == chosen }) throw IllegalArgumentException("Not offered.")
        val machine = directory?.members?.get(p.from)?.takeIf { it.active }?.member
            ?: throw IllegalStateException("The machine that asked is no longer in your directory.")
        val body = buildJsonObject {
            put("v", 1)
            put("id", newId("pa_"))
            put("permissionId", id)
            put("to", machine.id)
            put("answeredAt", now())
            put("behavior", if (allow) "allow" else "deny")
            put("scope", chosen)
            put("inputHash", p.body.inputHash)
            if (!allow) message?.trim()?.takeIf { it.isNotEmpty() }?.let { put("message", it.takeCodePoints(500)) }
            // Lets the machine notice a server holding back entries, such as a revocation.
            directory?.let { d -> putJsonObject("dir") { put("length", d.length); put("head", d.head) } }
        }
        val item = envelopes.seal("permission-answer", body, me.id, signKey, listOf(machine))
        try {
            api().postItem(item)
        } catch (e: ApiException) {
            if (e.error == "already-answered" || e.error == "expired") sync()
            if (e is TooOld) describe(e)
            throw e
        }
        val answer = if (allow) "allow:$chosen" else "deny"
        persist(saved.copy(prompts = saved.prompts.map { if (it.body.id == id) it.copy(answeredAt = now(), answer = answer) else it }))
    }

    /** For the notification's buttons: holds the lock like any other change. */
    suspend fun sendFromNotification(id: String, allow: Boolean, scope: String) =
        lock.withLock { send(id, allow, scope, null) }

    /** How a prompt ended, in words, from this device's answer or the machine's notice. */
    private fun ended(p: SavedPrompt) = promptEnded(p.answer, p.settled, p.answeredAt, p.body.source.machine, me.id) { directory?.members?.get(it)?.member?.name }

    private fun toUi(p: SavedPrompt): Prompt {
        val b = p.body
        return Prompt(
            id = b.id,
            tool = b.tool,
            summary = visible(b.summary),
            description = b.description?.let(::visible),
            input = b.input,
            scopes = b.suggestions.map { PromptScope(it.scope, it.label, visible(it.rule)) },
            source = Source(b.source.machine, b.source.project, b.source.session, b.source.sessionTitle, b.source.links.orEmpty().map { SessionLink(it.kind, it.url) }, b.source.machineKind),
            agent = b.agent,
            createdAt = instant(b.createdAt) ?: Instant.EPOCH,
            expiresAt = instant(b.expiresAt) ?: Instant.EPOCH,
            ended = ended(p),
            endedAt = instant(p.answeredAt),
        )
    }
}

/**
 * How a prompt ended and where, as the web's History puts it (#349): "Denied · on Pixel",
 * "Allowed for this session · on this phone"; null while it waits.
 */
internal fun promptEnded(answer: String?, s: Settled?, answeredAt: String?, machine: String, me: String, name: (String) -> String?): String? {
    val allowed = mapOf("once" to "Allowed once", "session" to "Allowed for this session", "project" to "Always allowed")
    answer?.let { return "${if (it == "deny") "Denied" else allowed[it.removePrefix("allow:")] ?: "Allowed"} · on this phone" }
    return when {
        s?.outcome == "keyboard" -> "Answered · on $machine"
        s?.outcome == "timeout" -> "Timed out: left to the keyboard"
        s?.outcome == "device" && s.device != null -> {
            val what = when (s.behavior) { "allow" -> "Allowed"; "deny" -> "Denied"; else -> "Answered" }
            "$what · on ${if (s.device == me) "this phone" else name(s.device) ?: "another device"}"
        }
        answeredAt != null -> "Answered · on another device"
        else -> null
    }
}

package dev.starbridge.app.data

import dev.starbridge.app.protocol.JoinApprovalBody
import dev.starbridge.app.protocol.JoinKeys
import dev.starbridge.app.protocol.JoinRequestBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.ProtocolException
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.time.Instant

/** Join requests: another phone or browser of the account asks to join, and this one compares digits and approves (PROTOCOL.md). */
internal class JoinKind(private val core: Core, private val joins: Joins) : ItemKind {
    override val pushes = setOf("join")
    val asks = MutableStateFlow<List<JoinAsk>>(emptyList())
    val comparison = MutableStateFlow<Comparison>(Comparison.Idle)

    private var watchJob: Job? = null
    private var compareJob: Job? = null

    /** The join requests as last listed, by id, so comparing uses what was listed. */
    private var views = mapOf<String, JoinView>()

    /** What comparing digits derived: the request, its body and the keys. */
    private var compared: Triple<JoinView, JoinRequestBody, JoinKeys>? = null

    override suspend fun onPush(kind: String, id: String, push: JsonObject) {
        val list = core.api().joins("0", 0)
        show(list)
        list.joins.find { it.id == id }?.let(::toAsk)?.let { core.alerts.join("join:${it.id}", it.name) }
    }

    override fun wipe() {
        watchJob?.cancel()
        compareJob?.cancel()
        compared = null
        asks.value = emptyList()
        comparison.value = Comparison.Idle
    }

    private fun toAsk(view: JoinView): JoinAsk? = runCatching {
        val body = joins.openRequest(view.request)
        JoinAsk(view.id, body.name, instant(body.at) ?: Instant.now(), elsewhere = view.approver != null && view.approver != core.saved.me?.id)
    }.getOrNull()

    private fun show(list: JoinList) {
        views = list.joins.associateBy { it.id }
        asks.value = list.joins.mapNotNull(::toAsk)
    }

    fun watch(on: Boolean) {
        watchJob?.cancel()
        if (!on) return
        watchJob = core.scope.launch {
            var cursor = "0"
            while (true) {
                if (core.phase.value != Phase.Ready) {
                    delay(5_000)
                    continue
                }
                try {
                    val list = core.api().joins(cursor, 50)
                    cursor = list.cursor
                    show(list)
                } catch (e: IOException) {
                    delay(5_000)
                }
            }
        }
    }

    /** Takes the request as listed and posts this phone's key; the digits come once the joiner reveals. */
    fun compare(id: String) {
        val view = views[id] ?: return
        val ask = toAsk(view) ?: return
        compareJob?.cancel()
        comparison.value = Comparison.Waiting(ask)
        compareJob = core.scope.launch {
            try {
                val body = joins.openRequest(view.request)
                if (body.account != core.saved.account) throw ProtocolException("wrong-account", body.account)
                if (body.join != view.id) throw ProtocolException("id-mismatch", "join")
                val eph = joins.newKeyPair()
                var after = core.api().claimJoin(id, toB64(eph.public), core.me.id).version - 1
                while (true) {
                    val now = try {
                        core.api().join(id, after, 60)
                    } catch (e: IOException) {
                        // Giving up would lose this phone's key, and the server takes one.
                        if (!transient(e)) throw e
                        if (instant(view.expiresAt)?.isBefore(Instant.now()) != false) throw IllegalStateException("The request expired.")
                        delay(5_000)
                        continue
                    }
                    after = now.version
                    if (now.state == "cancelled") throw IllegalStateException("${ask.name} cancelled the request.")
                    val joinerKey = now.joinerKey ?: continue
                    val keys = joins.approverKeys(eph, joinerKey, view.request, view.commitment)
                    eph.secret.fill(0)
                    compared = Triple(view, body, keys)
                    comparison.value = Comparison.Digits(ask, keys.digits)
                    return@launch
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                comparison.value = Comparison.Failed(if (e is IllegalStateException) e.message ?: "" else core.describe(e))
            }
        }
    }

    /** Appends the new device's entry, then sends the approval under the compared key. */
    fun approve() = core.run(showBusy = false) {
        val (view, body, keys) = compared ?: return@run
        val shown = comparison.value as? Comparison.Digits ?: return@run
        comparison.value = shown.copy(approving = true, error = null)
        try {
            core.syncDirectory()
            core.addMember(body.member(), "Another member already uses this id. Ask again from the new device.")
            val after = core.directory!!
            core.api().approveJoin(view.id, joins.approval(JoinApprovalBody(1, view.id, core.saved.account!!, after.length, after.head, core.me.id), keys))
            compared = null
            core.alerts.cancel("join:${view.id}")
            comparison.value = Comparison.Done("${body.name} joined.")
        } catch (e: Exception) {
            // The server holds this phone's key for the join, so a blip keeps the digits and
            // their keys for another try; the entry appended already is reused.
            comparison.value = if (e is IOException && transient(e)) shown.copy(error = core.describe(e)) else Comparison.Failed(core.describe(e))
        }
    }

    private fun transient(e: IOException) = e !is ApiException || e.status >= 500 || e.status == 429

    fun refuse(id: String) = core.run(showBusy = false) {
        compareJob?.cancel()
        val name = asks.value.find { it.id == id }?.name ?: "the device"
        val differed = compared?.first?.id == id
        compared = null
        core.alerts.cancel("join:$id")
        runCatching { core.api().cancelJoin(id) }
        asks.value = asks.value.filter { it.id != id }
        comparison.value = Comparison.Done(if (differed) "Refused $name: the digits differed." else "Refused $name.")
    }

    fun closeComparison() {
        compareJob?.cancel()
        compared = null
        comparison.value = Comparison.Idle
    }
}

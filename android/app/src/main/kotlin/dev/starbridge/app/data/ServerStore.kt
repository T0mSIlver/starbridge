package dev.starbridge.app.data

import android.util.Log
import dev.starbridge.app.protocol.Bip39
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Directory
import dev.starbridge.app.protocol.DirectoryEntry
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.JoinApprovalBody
import dev.starbridge.app.protocol.JoinKeys
import dev.starbridge.app.protocol.JoinRequestBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.KeyPair
import dev.starbridge.app.protocol.PairingApprovalBody
import dev.starbridge.app.protocol.Permission
import dev.starbridge.app.protocol.PairingCode
import dev.starbridge.app.protocol.PairingRequestBody
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolException
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.QuotaSnapshot
import dev.starbridge.app.protocol.RECOVERY
import dev.starbridge.app.protocol.Run as RunBody
import dev.starbridge.app.protocol.SealedBox
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.Settled
import dev.starbridge.app.protocol.Waiting
import dev.starbridge.app.protocol.SignedEnvelope
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.bindMessage
import dev.starbridge.app.protocol.checkJoined
import dev.starbridge.app.protocol.codeFromLink
import dev.starbridge.app.protocol.fromB64
import dev.starbridge.app.protocol.pairingLink
import dev.starbridge.app.protocol.parsePairingCode
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.IOException
import dev.starbridge.app.ui.span
import java.time.Instant
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.roundToInt
import dev.starbridge.app.protocol.Decision as DecisionBody
import dev.starbridge.app.protocol.Member as DirectoryMember

/** Shows and clears notifications; the app's is [dev.starbridge.app.push.Notifier]. */
interface Alerts {
    fun decision(decision: Decision)
    fun cancel(id: String)
    fun prompt(prompt: Prompt)
    fun cancelPrompt(prompt: Prompt)
    /** A browser or phone signed in to the account asks to join. */
    fun join(id: String, name: String)
    /** A run's newest update: shows, updates or ends its notification. */
    fun run(run: Run)
    /** Quota alerts the uploader newly raised; each shows once, if this phone opted in. */
    fun quota(notices: List<QuotaNotice>) {}
}

/** How long pull to refresh on Quotas waits for the machines' fresh snapshots. */
private const val QUOTA_ASK_SECONDS = 15

/**
 * The app's state against the server. Everything it shows was verified here first: the
 * directory chain against the pin, and each item against the directory (PROTOCOL.md).
 */
class ServerStore(
    private val disk: Disk,
    private val http: OkHttpClient,
    private val sodium: Sodium,
    private val envelopes: Envelopes,
    private val directories: Directories,
    private val pairings: Pairings,
    private val joins: Joins,
    private val alerts: Alerts,
    private val deviceName: String,
    private val defaultServer: String,
    private val fcmAvailable: Boolean,
    private val scope: CoroutineScope,
) : Store {
    private val lock = Mutex()
    private var saved = disk.saved() ?: Saved(defaultServer)
    private var secrets = disk.secrets()
    private var directory: Directory? = null
    private var pending: Pair<PairingCode, PairingRequestBody>? = null
    private var joinJob: Job? = null
    private var showJob: Job? = null
    private var watchJob: Job? = null
    private var compareJob: Job? = null
    /** The join requests as last listed, by id, so comparing uses what was listed. */
    private var joinViews = mapOf<String, JoinView>()
    /** What comparing digits derived: the request, its body and the keys. */
    private var compared: Triple<JoinView, JoinRequestBody, JoinKeys>? = null

    override val phase = MutableStateFlow<Phase>(Phase.SignedOut)
    override val decisions = MutableStateFlow<List<Decision>>(emptyList())
    override val prompts = MutableStateFlow<List<Prompt>>(emptyList())
    override val windows = MutableStateFlow<List<QuotaWindow>>(emptyList())
    override val runs = MutableStateFlow<List<Run>>(emptyList())
    override val members = MutableStateFlow<List<Member>>(emptyList())
    override val approval = MutableStateFlow<Approval>(Approval.Idle)
    override val joinAsks = MutableStateFlow<List<JoinAsk>>(emptyList())
    override val comparison = MutableStateFlow<Comparison>(Comparison.Idle)
    override val push = MutableStateFlow(PushSetting(saved.pushType, fcmAvailable, emptyList(), false))
    override val server = MutableStateFlow(saved.server)
    override val busy = MutableStateFlow(false)
    override val notice = MutableStateFlow<String?>(null)
    override val sending = MutableStateFlow<Map<String, String>>(emptyMap())

    init {
        directory = runCatching { verified(saved.entries) }.getOrNull()
        publish()
        if (saved.joining != null) waitForApproval()
        if (saved.digitJoin != null) waitForDigitJoin()
    }

    // --- State ------------------------------------------------------------------

    private fun api() = Api(http, saved.server, secrets.session)

    private fun now(): String = Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()

    private fun newId(prefix: String) = prefix + toB64(sodium.random(9))

    private fun verified(entries: List<JsonElement>): Directory? =
        if (entries.isEmpty()) null else directories.verify(entries, saved.account, saved.pin)

    private val me get() = saved.me ?: throw IllegalStateException("no device yet")
    private val box get() = KeyPair(fromB64(secrets.boxPk!!), fromB64(secrets.boxSk!!))
    private val signKey get() = fromB64(secrets.signSk!!)

    private fun persist(newSaved: Saved = saved, newSecrets: Secrets = secrets) {
        if (newSecrets != secrets) disk.save(newSecrets)
        if (newSaved != saved) disk.save(newSaved)
        saved = newSaved
        secrets = newSecrets
        publish()
    }

    private fun publish() {
        phase.value = when {
            secrets.session == null -> Phase.SignedOut
            saved.joining != null -> Phase.Joining(saved.joining!!, saved.joiningScanned)
            saved.digitJoin != null -> Phase.JoiningByDigits(saved.digitJoin!!.digits)
            saved.me == null || saved.pin == null -> Phase.NoDevice(saved.accountExists)
            secrets.recoverySeed != null -> Phase.RecoveryKey(Bip39.entropyToMnemonic(fromB64(secrets.recoverySeed!!)).split(" "))
            else -> Phase.Ready
        }
        server.value = saved.server
        push.value = push.value.copy(type = saved.pushType, registered = saved.push?.type == saved.pushType)
        decisions.value = saved.decisions.map(::toUi)
        prompts.value = saved.prompts.map(::toUi)
        // As the web: named once the account has more than one active machine.
        val named = (directory?.members?.values?.count { it.active && it.member.role == "machine" } ?: 0) > 1
        windows.value = saved.quotas.flatMap { toUi(it, named) }
        runs.value = saved.runs.map(::toUi)
        members.value = directory?.let(::toUi).orEmpty()
    }

    fun setDistributors(list: List<String>) {
        push.value = push.value.copy(distributors = list)
    }

    /** Runs [block] off the caller, one at a time, and turns failures into a notice. */
    private fun run(showBusy: Boolean = true, block: suspend () -> Unit) {
        scope.launch {
            lock.withLock {
                if (showBusy) busy.value = true
                try {
                    block()
                } catch (e: Exception) {
                    report(e)
                } finally {
                    busy.value = false
                }
            }
        }
    }

    private fun report(e: Exception) {
        Log.w("Starbridge", "failed", e)
        if (e is ApiException && e.status == 401 && secrets.session != null) {
            // The keys stay: signing in again binds a new session to this phone.
            persist(newSecrets = secrets.copy(session = null))
            notice.value = "Your session ended. Sign in again; this phone keeps its keys."
            return
        }
        notice.value = describe(e)
    }

    private fun describe(e: Exception): String = when (e) {
        is ApiException -> when (e.error) {
            "machine-cap" -> "This account already has its maximum number of machines. Revoke one first."
            "already-answered" -> "Already answered on another device."
            "rate-limited" -> "Too many tries. Wait a minute."
            "taken" -> "Another of your devices is already comparing digits for it."
            "closed" -> "That request was already answered or cancelled."
            else -> e.message ?: e.error
        }
        is ProtocolException -> "Refused: the server sent something that does not check out (${e.code})."
        is IOException -> "Can't reach ${saved.server}: ${e.message}"
        else -> e.message ?: e.toString()
    }

    private fun wipe(message: String?) {
        joinJob?.cancel()
        showJob?.cancel()
        watchJob?.cancel()
        compareJob?.cancel()
        compared = null
        joinAsks.value = emptyList()
        comparison.value = Comparison.Idle
        disk.wipe()
        saved = Saved(saved.server, pushType = saved.pushType)
        secrets = Secrets()
        directory = null
        pending = null
        approval.value = Approval.Idle
        publish()
        notice.value = message
    }

    // --- Signing in and setting up ------------------------------------------------

    private fun normalize(server: String) = server.trim().trimEnd('/').ifEmpty { defaultServer }

    override fun gitHubSignInUrl(server: String): String {
        val verifier = SignIn.newVerifier()
        persist(saved.copy(server = normalize(server)), secrets.copy(signInVerifier = verifier))
        return SignIn.url(saved.server, verifier)
    }

    /**
     * Only for the sign-in this phone started: without its verifier the code is worthless, and a
     * redirect with no sign-in pending is ignored. The code works once, whatever the outcome.
     */
    override fun receiveSignIn(redirect: String) = run {
        if (phase.value != Phase.SignedOut) return@run
        val code = SignIn.code(redirect) ?: return@run
        val verifier = secrets.signInVerifier ?: return@run
        persist(newSecrets = secrets.copy(signInVerifier = null))
        val session = try {
            Api(http, saved.server, null).appSession(code, verifier)
        } catch (e: ApiException) {
            throw IllegalStateException(if (e.error == "bad-code") "Sign-in expired. Sign in again." else describe(e))
        }
        afterSignIn(session)
    }

    override fun signInWithOwnerToken(server: String, token: String) = run {
        persist(saved.copy(server = normalize(server)))
        afterSignIn(Api(http, saved.server, null).ownerSignIn(token.trim()))
    }

    /** Checks the session with the server before keeping it. */
    private suspend fun afterSignIn(session: String) {
        val fresh = Api(http, saved.server, session)
        val me = try {
            fresh.me()
        } catch (e: ApiException) {
            throw IllegalStateException(if (e.status == 401) "Sign-in failed: the server did not accept the session." else describe(e))
        }
        val mine = saved.me
        if (mine != null && saved.pin != null && saved.joining == null && saved.digitJoin == null && secrets.signSk != null && me.account == saved.account) {
            // This phone is still a device: bind the new session with its signing key (PROTOCOL.md, "Auth").
            try {
                if (me.member == null) fresh.bind(mine.id, toB64(sodium.sign(bindMessage(me.account, mine.id, fresh.challenge()), signKey)))
                else if (me.member != mine.id) throw IllegalStateException("This session already belongs to another device.")
                persist(newSecrets = secrets.copy(session = session))
                sync()
                return
            } catch (e: ApiException) {
                if (e.status != 404) throw e
                // 404 means no such active device, or a server without binding: the chain decides.
                val dir = directories.verify(saved.entries + fresh.directory(saved.entries.size), saved.account, saved.pin)
                if (dir.members[mine.id]?.active == true) throw IllegalStateException("This server cannot bind a new session to this phone. Update the server.")
                wipe("This phone was removed from your devices. Set it up again.")
            }
        } else if (saved.pendingGenesis != null && me.account == saved.account) {
            // A first-device setup the server may already hold: keep its keys and seed to retry.
            persist(newSecrets = secrets.copy(session = session))
            return
        } else if (mine != null || secrets.signSk != null) {
            // Another account, or a setup that never finished: start over.
            wipe(null)
        }
        if (me.member != null) throw IllegalStateException("This session already belongs to another device.")
        val exists = fresh.directory(0).isNotEmpty()
        persist(newSecrets = Secrets(session = session))
        persist(saved.copy(account = me.account, accountExists = exists, me = null, pin = null, entries = emptyList()))
    }

    private fun newMember(): DirectoryMember {
        val boxKeys = sodium.boxKeyPair()
        val signKeys = sodium.signKeyPair()
        val member = DirectoryMember(newId("d_"), "device", deviceName.take(100).ifBlank { "Android" }, toB64(boxKeys.public), toB64(signKeys.public))
        // The keys reach the disk before the server hears of them, so a crash cannot strand them.
        persist(newSecrets = secrets.copy(boxPk = member.boxPk, boxSk = toB64(boxKeys.secret), signPk = member.signPk, signSk = toB64(signKeys.secret)))
        return member
    }

    /**
     * The keys, the seed and the signed genesis reach the disk before the server sees the entry,
     * so a lost response is retried with the same entry, and a chain that already starts with it
     * is adopted instead of refused.
     */
    override fun setUpFirstDevice() = run {
        if (saved.pendingGenesis == null) {
            if (api().directory(0).isNotEmpty()) throw IllegalStateException("This account already has devices. Join it instead.")
            val member = newMember()
            val seed = sodium.random(32)
            val entry = ProtocolJson.encodeToJsonElement(directories.genesisEntry(saved.account!!, member, signKey, sodium.signSeedKeyPair(seed), now()))
            persist(saved.copy(me = member, pin = null, pendingGenesis = entry), secrets.copy(recoverySeed = toB64(seed)))
        }
        val genesis: JsonElement = saved.pendingGenesis!!
        val existing = api().directory(0)
        if (existing.isEmpty()) api().append(ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), genesis))
        else if (existing.first() != genesis) throw IllegalStateException("This account already has devices. Join it instead.")
        else if (api().me().member == null) {
            // The server took the entry but the session that posted it is gone: bind this one.
            api().bind(me.id, toB64(sodium.sign(bindMessage(saved.account!!, me.id, api().challenge()), signKey)))
        }
        val entries = listOf(genesis)
        val dir = directories.verify(entries, saved.account)
        directory = dir
        persist(saved.copy(entries = entries, pin = Pin(dir.length, dir.head), pendingGenesis = null))
    }

    override fun confirmRecoveryKey() = run {
        persist(newSecrets = secrets.copy(recoverySeed = null))
        sync()
    }

    override fun joinAccount() = run { join(pairings.newCode(), scanned = false) }

    override fun joinWithCode(text: String) = run {
        val code = try {
            codeFromLink(text)
        } catch (e: ProtocolException) {
            throw IllegalArgumentException("That QR code is not a Starbridge pairing code.")
        }
        try {
            join(code, scanned = true)
        } catch (e: ApiException) {
            throw if (e.error == "taken") IllegalStateException("Another phone already used this code. Show a new one.") else e
        }
    }

    /** Posts this phone's request under [code], which it made or scanned, and waits for approval. */
    private suspend fun join(code: PairingCode, scanned: Boolean) {
        val member = newMember()
        val claim = pairings.newClaimSecret()
        val request = pairings.request(PairingRequestBody(1, code.rendezvous, "device", member.id, member.name, member.boxPk, member.signPk, now()), code)
        api().postPairing(request, pairings.claimHash(claim))
        persist(saved.copy(me = member, joining = code.formatted(), joiningScanned = scanned), secrets.copy(claim = claim))
        waitForApproval()
    }

    private fun waitForApproval() {
        joinJob?.cancel()
        joinJob = scope.launch {
            val code = parsePairingCode(saved.joining ?: return@launch)
            try {
                while (true) {
                    val result = try {
                        api().pairingResult(code.rendezvous, secrets.claim!!, 60)
                    } catch (e: IOException) {
                        if (e is ApiException) throw e
                        // Offline for a moment: keep waiting, the code stays valid for 10 minutes.
                        delay(5_000)
                        null
                    } ?: continue
                    lock.withLock { finishJoin(code, result.approval) }
                    // Joined: a failing first sync must not undo that, so it runs on its own.
                    refresh()
                    return@launch
                }
            } catch (e: ApiException) {
                lock.withLock {
                    persist(saved.copy(me = null, joining = null, joiningScanned = false), secrets.copy(claim = null))
                    notice.value = if (e.status == 404) "The code expired. Make a new one." else if (e.error == "taken") "Another phone already used this code. Show a new one." else describe(e)
                }
            } catch (e: IOException) {
                // Fetching the chain after the approval failed; the next start resumes the wait.
                notice.value = describe(e)
            } catch (e: ProtocolException) {
                lock.withLock {
                    persist(saved.copy(me = null, joining = null), secrets.copy(claim = null))
                    report(e)
                }
            }
        }
    }

    /** The approval's MAC proves the owner typed this code; the chain must hold this device. */
    private suspend fun finishJoin(code: PairingCode, approvalMessage: JsonElement) {
        val approved = pairings.openApproval(approvalMessage, code)
        if (approved.account != saved.account) throw ProtocolException("wrong-account", approved.account)
        val entries = api().directory(0)
        val dir = directories.verify(entries, saved.account, Pin(approved.length, approved.head))
        checkJoined(dir, me)
        directory = dir
        persist(saved.copy(joining = null, entries = entries, pin = Pin(dir.length, dir.head)), secrets.copy(claim = null))
    }

    override fun cancelJoin() = run(showBusy = false) {
        joinJob?.cancel()
        saved.digitJoin?.let { runCatching { api().cancelJoin(it.id) } }
        persist(saved.copy(me = null, joining = null, joiningScanned = false, digitJoin = null), secrets.copy(claim = null, joinPk = null, joinSk = null))
    }

    // --- Joining by digits (PROTOCOL.md) ------------------------------------------

    override fun askDevices() = run {
        val member = newMember()
        val eph = joins.newKeyPair()
        val id = joins.newId()
        val request = joins.request(JoinRequestBody(1, id, saved.account!!, member.id, member.name, member.boxPk, member.signPk, now()))
        // The key pair reaches the disk first, so a restart resumes the same join.
        persist(saved.copy(me = member, digitJoin = SavedDigitJoin(id, request)), secrets.copy(joinPk = toB64(eph.public), joinSk = toB64(eph.secret)))
        try {
            api().postJoin(request, joins.commitment(eph.public, request))
        } catch (e: Exception) {
            persist(saved.copy(me = null, digitJoin = null), secrets.copy(joinPk = null, joinSk = null))
            throw e
        }
        waitForDigitJoin()
    }

    private fun clearDigitJoin() = persist(saved.copy(me = null, digitJoin = null), secrets.copy(joinPk = null, joinSk = null))

    private fun waitForDigitJoin() {
        joinJob?.cancel()
        joinJob = scope.launch {
            val id = saved.digitJoin?.id ?: return@launch
            var after = 0L
            try {
                while (true) {
                    val view = try {
                        api().join(id, after, 60)
                    } catch (e: IOException) {
                        if (e is ApiException) throw e
                        delay(5_000)
                        continue
                    }
                    after = view.version
                    if (view.state == "cancelled") throw IllegalStateException("The request was refused or cancelled. Ask again.")
                    val done = try {
                        lock.withLock { stepDigitJoin(view) }
                    } catch (e: IOException) {
                        if (e is ApiException) throw e
                        // Offline while revealing or fetching the chain: the next step retries.
                        delay(5_000)
                        after = 0
                        continue
                    }
                    if (done) {
                        refresh()
                        return@launch
                    }
                }
            } catch (e: ApiException) {
                lock.withLock {
                    clearDigitJoin()
                    notice.value = if (e.status == 404) "The request expired. Ask again." else describe(e)
                }
            } catch (e: ProtocolException) {
                lock.withLock {
                    clearDigitJoin()
                    report(e)
                }
            } catch (e: IllegalStateException) {
                lock.withLock {
                    clearDigitJoin()
                    notice.value = e.message
                }
            }
        }
    }

    /**
     * One step of a join by digits, for the state [view] shows: takes the first approver key and
     * reveals this phone's key, then checks the approval. True once this phone is in the chain.
     */
    private suspend fun stepDigitJoin(view: JoinView): Boolean {
        var dj = saved.digitJoin ?: return true
        val eph = KeyPair(fromB64(secrets.joinPk!!), fromB64(secrets.joinSk!!))
        if (dj.approverKey == null && view.approverKey != null) {
            val keys = joins.joinerKeys(eph, view.approverKey, dj.request)
            dj = dj.copy(approverKey = view.approverKey, digits = keys.digits)
            persist(saved.copy(digitJoin = dj))
        }
        val approverKey = dj.approverKey ?: return false
        if (view.joinerKey == null && view.approverKey == approverKey) {
            try {
                api().revealJoin(dj.id, toB64(eph.public))
            } catch (e: ApiException) {
                if (e.error != "already-revealed") throw e
            }
        }
        val approval = view.approval ?: return false
        val keys = joins.joinerKeys(eph, approverKey, dj.request)
        val body = joins.openApproval(approval, keys, dj.id)
        if (body.account != saved.account) throw ProtocolException("wrong-account", body.account)
        val entries = api().directory(0)
        val dir = directories.verify(entries, saved.account, Pin(body.length, body.head))
        checkJoined(dir, me)
        directory = dir
        persist(saved.copy(digitJoin = null, entries = entries, pin = Pin(dir.length, dir.head)), secrets.copy(joinPk = null, joinSk = null))
        return true
    }

    override fun recover(words: String) = run {
        val seed = try {
            Bip39.mnemonicToEntropy(words)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("Those words are not a recovery key. Check each word and the order.")
        }
        val recovery = sodium.signSeedKeyPair(seed)
        val entries = api().directory(0)
        // The chain's first entry must carry this key's own signature, which a server cannot fake.
        val dir = directories.verify(entries, saved.account, recoveryPk = toB64(recovery.public))
        val member = newMember()
        val entry = directories.addEntry(dir, RECOVERY, recovery.secret, member, now())
        api().append(entry)
        val all = entries + ProtocolJson.encodeToJsonElement(entry)
        val after = directories.verify(all, saved.account, Pin(dir.length, dir.head))
        directory = after
        persist(saved.copy(me = member, entries = all, pin = Pin(after.length, after.head)))
        sync()
    }

    // --- Syncing -----------------------------------------------------------------

    override fun refresh() = run { sync() }

    // Outside the lock: the machines take seconds to post, and answers must not wait on them.
    override fun refreshQuotas() {
        scope.launch {
            busy.value = true
            try {
                if (phase.value == Phase.Ready) api().askQuota(QUOTA_ASK_SECONDS)
            } catch (e: ApiException) {
                // Asked too often, or a server without asks: the sync shows what it holds.
            } catch (e: IOException) {
                // Offline: the sync reports it.
            }
            run { sync() }
        }
    }

    private suspend fun sync() {
        if (phase.value != Phase.Ready) return
        syncDirectory()
        if (phase.value != Phase.Ready) return
        syncDecisions()
        syncPrompts()
        syncQuotas()
        syncRuns()
    }

    /** Fetches what is new and replays the whole chain; it must extend the pin. */
    private suspend fun syncDirectory() {
        val fresh = api().directory(saved.entries.size)
        val all = saved.entries + fresh
        val dir = directories.verify(all, saved.account, saved.pin)
        directory = dir
        if (dir.members[me.id]?.active != true) {
            wipe("This phone was removed from your devices.")
            return
        }
        persist(saved.copy(entries = all, pin = Pin(dir.length, dir.head)))
    }

    private fun open(item: SealedItem): Pair<String, Any>? = try {
        val opened = envelopes.open(item, me.id, box, directory!!)
        item.from to opened.body
    } catch (e: ProtocolException) {
        // Not shown: an item that fails its checks is the server's or a stranger's.
        Log.w("Starbridge", "dropped ${item.kind} ${item.id}: ${e.message}")
        null
    }

    private suspend fun syncDecisions() {
        // Saved by an app that dropped fields it did not know: read every open one again.
        val reread = saved.decisionFields < DECISION_FIELDS
        var cursor = if (reread) "" else saved.cursor
        val byId = saved.decisions.associateBy { it.body.id }.toMutableMap()
        // How each item a settled notice closed was closed, with the time: the notice lists before
        // the decision it closed, which moved past it.
        val closings = mutableMapOf<String, Pair<String?, String>>()
        val waits = mutableListOf<Pair<String, Waiting>>()
        while (true) {
            val page = api().items("decision,settled,waiting", cursor)
            for (listed in page.items) {
                if (listed.item.kind == "waiting") {
                    val (from, body) = open(listed.item) ?: continue
                    waits += from to body as Waiting
                    continue
                }
                if (listed.item.kind == "settled") {
                    val (_, body) = open(listed.item) ?: continue
                    body as Settled
                    closings[body.itemId] = body.outcome to listed.receivedAt
                    continue
                }
                // The notice that closed it arrived in the same write, so it carries the same time;
                // a later one, after a device's answer, closed nothing.
                val settled = closings[listed.item.id]?.takeIf { it.second == listed.answeredAt }?.first
                val known = byId[listed.item.id]
                if (known != null && reread && known.answeredAt == null && listed.answeredAt == null) {
                    val (from, body) = open(listed.item) ?: continue
                    if (from == known.from) byId[known.body.id] = known.copy(body = body as DecisionBody)
                    continue
                }
                if (known != null) {
                    // A settled push marked it answered already, without saying how.
                    if (listed.answeredAt != null && (known.answeredAt == null || settled != null)) {
                        byId[known.body.id] = known.copy(answeredAt = listed.answeredAt, settled = settled ?: known.settled)
                        alerts.cancel(known.body.id)
                    }
                    continue
                }
                val (from, body) = open(listed.item) ?: continue
                byId[listed.item.id] = SavedDecision(from, body as DecisionBody, listed.answeredAt, settled = settled)
            }
            cursor = page.cursor
            if (page.items.size < 100) break
        }
        // An update may list before the decision it is about, so they apply once all are read.
        for ((from, w) in waits) byId[w.decisionId]?.let { d -> wait(d, from, w)?.let { byId[w.decisionId] = it } }
        persist(saved.copy(cursor = cursor, decisions = byId.values.sortedBy { it.body.createdAt }.takeLast(500), decisionFields = DECISION_FIELDS))
    }

    /**
     * [d] with the agent's waiting state from [w], or null when [w] changes nothing: it must come
     * from the machine that asked, and only a later update replaces an earlier one.
     */
    private fun wait(d: SavedDecision, from: String, w: Waiting): SavedDecision? {
        if (d.from != from) return null
        val at = instant(w.at) ?: return null
        if (d.waitingAt != null && instant(d.waitingAt)?.isBefore(at) == false) return null
        return d.copy(waiting = w.state, waitingAt = w.at)
    }

    /**
     * Reads permission prompts and settled notices past the cursor. A prompt comes again once it
     * is answered or settled, with its time; a notice counts only from the machine that asked.
     */
    private suspend fun syncPrompts() {
        var cursor = saved.promptCursor
        val byId = saved.prompts.associateBy { it.body.id }.toMutableMap()
        val read = mutableListOf<Listed>()
        while (true) {
            val page = api().items("permission,settled", cursor)
            read += page.items
            cursor = page.cursor
            if (page.items.size < 100) break
        }
        // A settled prompt comes back after its notice, so prompts go first: a notice whose
        // prompt is new to this phone would otherwise find nothing to close.
        for (listed in read.sortedBy { if (it.item.kind == "permission") 0 else 1 }) takePrompt(listed.item, listed.answeredAt, byId)
        keepPrompts(byId, cursor)
    }

    /** Merges one verified prompt or notice into [byId]; clears the notification of one that ended. */
    private fun takePrompt(item: SealedItem, answeredAt: String?, byId: MutableMap<String, SavedPrompt>): SavedPrompt? {
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
                val (from, body) = open(item) ?: return null
                return SavedPrompt(from, body as Permission, answeredAt).also { byId[item.id] = it }
            }
            "settled" -> {
                val (from, body) = open(item) ?: return null
                val notice = body as Settled
                val p = byId[notice.itemId]
                if (p == null) {
                    settleDecision(notice.itemId, from, notice.outcome)
                    return null
                }
                if (p.from != from) return null
                byId[p.body.id] = p.copy(settled = notice, answeredAt = p.answeredAt ?: notice.at)
                alerts.cancelPrompt(toUi(p))
            }
        }
        return null
    }

    /** A settled notice may close one of the machine's decisions: it counts as answered. */
    /** A notice after a device's answer closed nothing, so only an open decision takes its [outcome]. */
    private fun settleDecision(id: String, from: String, outcome: String?) {
        val d = saved.decisions.find { it.body.id == id && it.from == from } ?: return
        alerts.cancel(id)
        if (d.answeredAt == null && d.answer == null) persist(saved.copy(decisions = saved.decisions.map { if (it === d) it.copy(answeredAt = now(), settled = outcome) else it }))
    }

    /** Keeps a week of prompts, the log's span, as the server does. */
    private fun keepPrompts(byId: Map<String, SavedPrompt>, cursor: String = saved.promptCursor) {
        val weekAgo = Instant.now().minus(7, ChronoUnit.DAYS)
        val kept = byId.values.filter { instant(it.body.createdAt)?.isAfter(weekAgo) != false }.sortedBy { it.body.createdAt }
        persist(saved.copy(promptCursor = cursor, prompts = kept))
    }

    override fun refreshPrompts() = run(showBusy = false) {
        if (phase.value == Phase.Ready) syncPrompts()
    }

    override fun answerPrompt(id: String, allow: Boolean, scope: String, message: String?) =
        run(showBusy = false) { sendPrompt(id, allow, scope, message) }

    /**
     * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
     * asked. A deny is for this call only; a wider allow only for a scope the prompt offered.
     */
    suspend fun sendPrompt(id: String, allow: Boolean, scope: String, message: String?) {
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
            if (!allow) message?.trim()?.takeIf { it.isNotEmpty() }?.let { put("message", it.take(500)) }
        }
        val item = envelopes.seal("permission-answer", body, me.id, signKey, listOf(machine))
        try {
            api().postItem(item)
        } catch (e: ApiException) {
            if (e.error == "already-answered" || e.error == "expired") syncPrompts()
            throw e
        }
        val answer = if (allow) "allow:$chosen" else "deny"
        persist(saved.copy(prompts = saved.prompts.map { if (it.body.id == id) it.copy(answeredAt = now(), answer = answer) else it }))
    }

    /** For the notification's buttons: holds the lock like any other change. */
    suspend fun sendPromptFromNotification(id: String, allow: Boolean, scope: String) =
        lock.withLock { sendPrompt(id, allow, scope, null) }

    private suspend fun syncQuotas() {
        val quotas = api().quota().mapNotNull { listed -> open(listed.item)?.let { (from, body) -> SavedQuota(from, body as QuotaSnapshot) } }
        persist(saved.copy(quotas = quotas))
        alerts.quota(quotas.flatMap(::notices))
    }

    private fun notices(q: SavedQuota): List<QuotaNotice> {
        val now = Instant.now()
        val labels = q.body.providers.flatMap { p -> p.windows.map { "${p.provider}/${it.id}" to it.label.ifBlank { it.id } } }.toMap()
        return q.body.alerts.filter { it.notify == true }.map { a ->
            val name = "${a.provider} ${labels["${a.provider}/${a.window}"] ?: a.window}"
            val resets = instant(a.resetsAt)?.let { "in ${span(now, it)}" } ?: "soon"
            val (title, text) = when (a.kind) {
                "low" -> "$name: ${a.threshold}% left" to "Resets $resets."
                "runs-out" -> "$name will run out" to (instant(a.runsOutAt)?.let { "Runs out in ${span(now, it)} at this pace; resets $resets." } ?: "Resets $resets.")
                else -> "$name resets with headroom unused" to "Resets $resets with ${a.unusedPercent?.roundToInt() ?: 0}% unused."
            }
            QuotaNotice("${q.body.id}/${a.provider}/${a.window}/${a.kind}", a.provider, a.window, a.kind, title, text)
        }
    }

    /** Every run the server holds, the latest update of each. */
    private suspend fun syncRuns() {
        var cursor = ""
        val fresh = mutableListOf<SavedRun>()
        while (true) {
            val page = api().items("run", cursor)
            for (listed in page.items) open(listed.item)?.let { (from, body) -> fresh += SavedRun(from, body as RunBody) }
            cursor = page.cursor
            if (page.items.size < 100) break
        }
        keepRuns(fresh, fromSync = true)
    }

    /**
     * Keeps each update newer than the one held for its run (by `at`, then the exit), drops runs
     * with no news for a day, as the server does, and hands each newer update to [alerts]. A sync
     * skips runs it first learns of already ended, so a new phone does not alert for old results.
     */
    private fun keepRuns(updates: List<SavedRun>, fromSync: Boolean = false) {
        fun rank(r: SavedRun) = (instant(r.body.at) ?: Instant.EPOCH) to (r.body.exit != null)
        val held = saved.runs.associateBy { it.body.id }.toMutableMap()
        val newer = updates.filter { u ->
            val h = held[u.body.id]
            val (at, exited) = rank(u)
            val wins = h == null || rank(h).let { (hAt, hExited) -> at > hAt || (at == hAt && exited && !hExited) }
            if (wins) held[u.body.id] = u
            wins && !(fromSync && h == null && exited)
        }
        val dayAgo = Instant.now().minus(java.time.Duration.ofDays(1))
        persist(saved.copy(runs = held.values.filter { toUi(it).lastNews > dayAgo }.sortedBy { it.body.startedAt }))
        newer.forEach { alerts.run(toUi(it)) }
    }

    // --- Answering ---------------------------------------------------------------

    /** One answer per decision at a time: the decision stays locked until the server replies. */
    override fun answer(id: String, choice: String?, text: String?) {
        if (id in sending.value) return
        sending.update { it + (id to (choice ?: text.orEmpty())) }
        run(showBusy = false) {
            try {
                send(id, choice, text)
            } finally {
                sending.update { it - id }
            }
        }
    }

    /**
     * Signs the answer and seals it to the machine that asked, the only recipient the server
     * accepts. The notification's buttons call this too.
     */
    suspend fun send(id: String, choice: String?, text: String?) {
        val d = saved.decisions.find { it.body.id == id } ?: throw IllegalStateException("No such decision.")
        if (d.answeredAt != null || d.answer != null) throw IllegalStateException("Already answered.")
        if (choice != null && choice !in d.body.options) throw IllegalArgumentException("Not one of the options.")
        val machine = directory?.members?.get(d.from)?.takeIf { it.active }?.member
            ?: throw IllegalStateException("The machine that asked is no longer in your directory.")
        val answerId = newId("a_")
        val body = buildJsonObject {
            put("v", 1)
            put("id", answerId)
            put("decisionId", id)
            put("to", machine.id)
            put("answeredAt", now())
            choice?.let { put("choice", it) }
            text?.let { put("text", it) }
        }
        val item = envelopes.seal("answer", body, me.id, signKey, listOf(machine))
        try {
            api().postItem(item)
        } catch (e: ApiException) {
            if (e.error == "already-answered") markAnswered(id, null)
            throw e
        }
        markAnswered(id, choice ?: text)
    }

    private fun markAnswered(id: String, answer: String?) {
        persist(saved.copy(decisions = saved.decisions.map { if (it.body.id == id) it.copy(answeredAt = now(), answer = answer) else it }))
    }

    /** For the notification's buttons: holds the lock like any other change. */
    suspend fun sendFromNotification(id: String, choice: String?, text: String?) = lock.withLock { send(id, choice, text) }

    // --- Push --------------------------------------------------------------------

    /**
     * A push payload (PROTOCOL.md, "Push"): a new item with this device's box when it fits, else
     * its id to fetch; or `answered` once a decision is answered anywhere.
     */
    suspend fun onPush(payload: String) = lock.withLock {
        if (phase.value != Phase.Ready) return@withLock
        val p = ProtocolJson.parseToJsonElement(payload).jsonObject
        val kind = p["kind"]?.jsonPrimitive?.content
        val id = p["id"]?.jsonPrimitive?.content ?: return@withLock
        when (kind) {
            "answered" -> {
                saved.prompts.find { it.body.id == id }?.let { p ->
                    alerts.cancelPrompt(toUi(p))
                    if (p.answeredAt == null) persist(saved.copy(prompts = saved.prompts.map { if (it === p) it.copy(answeredAt = now()) else it }))
                    return@withLock
                }
                alerts.cancel(id)
                val d = saved.decisions.find { it.body.id == id }
                if (d != null && d.answeredAt == null) persist(saved.copy(decisions = saved.decisions.map { if (it === d) it.copy(answeredAt = now()) else it }))
            }
            "decision" -> {
                if (saved.decisions.any { it.body.id == id }) return@withLock
                val box = p["box"]?.jsonPrimitive?.content
                var answeredAt: String? = null
                val item = if (box != null) {
                    SealedItem(1, "decision", id, p.getValue("from").jsonPrimitive.content, p["re"]?.jsonPrimitive?.content, listOf(SealedBox(me.id, box)))
                } else {
                    // Fetched later than the push: another device may have answered meanwhile.
                    api().item(id).also { answeredAt = it.answeredAt }.item
                }
                // A machine paired since the last sync is not in the cached chain yet.
                if (directory?.members?.containsKey(item.from) != true) syncDirectory()
                val (from, body) = open(item) ?: return@withLock
                val saved1 = SavedDecision(from, body as DecisionBody, answeredAt)
                persist(saved.copy(decisions = saved.decisions + saved1))
                if (answeredAt == null) alerts.decision(toUi(saved1))
            }
            "permission", "settled" -> {
                if (kind == "permission" && saved.prompts.any { it.body.id == id }) return@withLock
                val box = p["box"]?.jsonPrimitive?.content
                var answeredAt: String? = null
                val item = if (box != null) {
                    SealedItem(1, kind, id, p.getValue("from").jsonPrimitive.content, p["re"]?.jsonPrimitive?.content, listOf(SealedBox(me.id, box)))
                } else {
                    api().item(id).also { answeredAt = it.answeredAt }.item
                }
                if (directory?.members?.containsKey(item.from) != true) syncDirectory()
                val byId = saved.prompts.associateBy { it.body.id }.toMutableMap()
                val added = takePrompt(item, answeredAt, byId)
                keepPrompts(byId)
                if (added != null && added.answeredAt == null) alerts.prompt(toUi(added))
            }
            "waiting" -> {
                // Pushed only when the agent flips to waiting: re-notify once, if still open.
                val box = p["box"]?.jsonPrimitive?.content
                val item = if (box != null) {
                    SealedItem(1, "waiting", id, p.getValue("from").jsonPrimitive.content, p["re"]?.jsonPrimitive?.content, listOf(SealedBox(me.id, box)))
                } else {
                    api().item(id).item
                }
                if (directory?.members?.containsKey(item.from) != true) syncDirectory()
                val (from, body) = open(item) ?: return@withLock
                body as Waiting
                val d = saved.decisions.find { it.body.id == body.decisionId } ?: return@withLock
                val updated = wait(d, from, body) ?: return@withLock
                persist(saved.copy(decisions = saved.decisions.map { if (it === d) updated else it }))
                if (d.waiting != "waiting" && updated.waiting == "waiting" && d.answeredAt == null && d.answer == null) alerts.decision(toUi(updated))
            }
            "quota" -> syncQuotas()
            "join" -> {
                val list = api().joins("0", 0)
                listJoins(list)
                list.joins.find { it.id == id }?.let(::toAsk)?.let { alerts.join("join:${it.id}", it.name) }
            }
            "run" -> {
                val box = p["box"]?.jsonPrimitive?.content
                val item = if (box != null) {
                    SealedItem(1, "run", id, p.getValue("from").jsonPrimitive.content, null, listOf(SealedBox(me.id, box)))
                } else {
                    api().item(id).item
                }
                if (directory?.members?.containsKey(item.from) != true) syncDirectory()
                val (from, body) = open(item) ?: return@withLock
                keepRuns(listOf(SavedRun(from, body as RunBody)))
            }
        }
    }

    /** Registers where pushes go; a new endpoint replaces the old subscription. */
    suspend fun subscribe(type: String, endpoint: String, keys: Pair<String, String>?) = lock.withLock {
        if (phase.value != Phase.Ready || type != saved.pushType) return@withLock
        val old = saved.push
        if (old != null && old.type == type && old.endpoint == endpoint) return@withLock
        if (old != null) {
            runCatching { api().unsubscribe(old.id) }
            // Forgotten first, so a failed replacement is not mistaken for a working route.
            persist(saved.copy(push = null))
        }
        val id = api().subscribe(type, endpoint, keys)
        persist(saved.copy(push = SavedPush(type, id, endpoint)))
    }

    override fun setPushType(type: String) = run(showBusy = false) {
        persist(saved.copy(pushType = type))
    }

    // --- Pairing and revoking ----------------------------------------------------

    override fun lookUpPairing(code: String) = run(showBusy = false) {
        approval.value = Approval.Checking
        val parsed = try {
            codeFromLink(code)
        } catch (e: ProtocolException) {
            approval.value = Approval.Failed("A pairing code has 24 letters and digits.")
            return@run
        }
        val request = try {
            api().pairing(parsed.rendezvous)
        } catch (e: IOException) {
            approval.value = Approval.Failed(if (e is ApiException && e.status == 404) "No pairing with this code, or it expired." else describe(e))
            return@run
        }
        val body = try {
            pairings.openRequest(request, parsed)
        } catch (e: ProtocolException) {
            approval.value = Approval.Failed("This request does not match the code. Don't approve it; make a new code.")
            return@run
        }
        pending = parsed to body
        approval.value = Approval.Found(body.name, if (body.role == "machine") Kind.Machine else Kind.Device, parsed.formatted())
    }

    /** Appends the new member's entry, then sends the approval that lets it check the chain. */
    override fun approvePairing() = run(showBusy = false) {
        val (code, body) = pending ?: return@run
        approval.value = Approval.Approving(approval.value as? Approval.Found ?: return@run)
        try {
            syncDirectory()
            val joining = body.member()
            // A retry after the approval failed to send finds the entry already in the chain.
            val present = directory!!.members[joining.id]
            if (present == null) {
                val entry = directories.addEntry(directory!!, me.id, signKey, joining, now())
                api().append(entry)
                val all = saved.entries + ProtocolJson.encodeToJsonElement(entry)
                val after = directories.verify(all, saved.account, saved.pin)
                directory = after
                persist(saved.copy(entries = all, pin = Pin(after.length, after.head)))
            } else if (!present.active || present.member != joining) {
                throw IllegalStateException("Another member already uses this id. Make a new code.")
            }
            val after = directory!!
            api().approve(code.rendezvous, pairings.approval(PairingApprovalBody(1, code.rendezvous, saved.account!!, after.length, after.head, me.id), code))
            pending = null
            approval.value = Approval.Done(body.name)
        } catch (e: Exception) {
            approval.value = Approval.Failed(describe(e))
        }
    }

    override fun closePairing() {
        showJob?.cancel()
        pending = null
        approval.value = Approval.Idle
    }

    /** The new phone scans the link and posts under the code; its MAC proves it holds the code. */
    override fun showCode() {
        showJob?.cancel()
        val code = pairings.newCode()
        approval.value = Approval.Showing(code.formatted(), pairingLink(saved.server, code))
        showJob = scope.launch {
            val until = System.currentTimeMillis() + 10 * 60_000
            try {
                while (System.currentTimeMillis() < until) {
                    val request = try {
                        api().awaitPairing(code.rendezvous, 60)
                    } catch (e: IOException) {
                        if (e is ApiException) throw e
                        delay(5_000)
                        null
                    } ?: continue
                    val body = try {
                        pairings.openRequest(request, code)
                    } catch (e: ProtocolException) {
                        approval.value = Approval.Failed("The request does not match the code. Don't approve it; show a new code.")
                        return@launch
                    }
                    pending = code to body
                    approval.value = Approval.Found(body.name, if (body.role == "machine") Kind.Machine else Kind.Device, code.formatted())
                    return@launch
                }
                approval.value = Approval.Failed("The code expired. Show a new one.")
            } catch (e: ApiException) {
                approval.value = Approval.Failed(describe(e))
            }
        }
    }

    // --- Approving joins by digits ---------------------------------------------------

    private fun toAsk(view: JoinView): JoinAsk? = runCatching {
        val body = joins.openRequest(view.request)
        JoinAsk(view.id, body.name, instant(body.at) ?: Instant.now(), elsewhere = view.approver != null && view.approver != saved.me?.id)
    }.getOrNull()

    private fun listJoins(list: JoinList) {
        joinViews = list.joins.associateBy { it.id }
        joinAsks.value = list.joins.mapNotNull(::toAsk)
    }

    override fun watchJoins(on: Boolean) {
        watchJob?.cancel()
        if (!on) return
        watchJob = scope.launch {
            var cursor = "0"
            while (true) {
                if (phase.value != Phase.Ready) {
                    delay(5_000)
                    continue
                }
                try {
                    val list = api().joins(cursor, 50)
                    cursor = list.cursor
                    listJoins(list)
                } catch (e: IOException) {
                    delay(5_000)
                }
            }
        }
    }

    /** Takes the request as listed and posts this phone's key; the digits come once the joiner reveals. */
    override fun compareJoin(id: String) {
        val view = joinViews[id] ?: return
        val ask = toAsk(view) ?: return
        compareJob?.cancel()
        comparison.value = Comparison.Waiting(ask)
        compareJob = scope.launch {
            try {
                val body = joins.openRequest(view.request)
                if (body.account != saved.account) throw ProtocolException("wrong-account", body.account)
                if (body.join != view.id) throw ProtocolException("id-mismatch", "join")
                val eph = joins.newKeyPair()
                var after = api().claimJoin(id, toB64(eph.public), me.id).version - 1
                while (true) {
                    val now = try {
                        api().join(id, after, 60)
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
                comparison.value = Comparison.Failed(if (e is IllegalStateException) e.message ?: "" else describe(e))
            }
        }
    }

    /** Appends the new device's entry, then sends the approval under the compared key. */
    override fun approveJoin() = run(showBusy = false) {
        val (view, body, keys) = compared ?: return@run
        val shown = comparison.value as? Comparison.Digits ?: return@run
        comparison.value = shown.copy(approving = true, error = null)
        try {
            syncDirectory()
            val joining = body.member()
            val present = directory!!.members[joining.id]
            if (present == null) {
                val entry = directories.addEntry(directory!!, me.id, signKey, joining, now())
                api().append(entry)
                val all = saved.entries + ProtocolJson.encodeToJsonElement(entry)
                val after = directories.verify(all, saved.account, saved.pin)
                directory = after
                persist(saved.copy(entries = all, pin = Pin(after.length, after.head)))
            } else if (!present.active || present.member != joining) {
                throw IllegalStateException("Another member already uses this id. Ask again from the new device.")
            }
            val after = directory!!
            api().approveJoin(view.id, joins.approval(JoinApprovalBody(1, view.id, saved.account!!, after.length, after.head, me.id), keys))
            compared = null
            alerts.cancel("join:${view.id}")
            comparison.value = Comparison.Done("${body.name} joined.")
        } catch (e: Exception) {
            // The server holds this phone's key for the join, so a blip keeps the digits and
            // their keys for another try; the entry appended already is reused.
            comparison.value = if (e is IOException && transient(e)) shown.copy(error = describe(e)) else Comparison.Failed(describe(e))
        }
    }

    private fun transient(e: IOException) = e !is ApiException || e.status >= 500 || e.status == 429

    override fun refuseJoin(id: String) = run(showBusy = false) {
        compareJob?.cancel()
        val name = joinAsks.value.find { it.id == id }?.name ?: "the device"
        val differed = compared?.first?.id == id
        compared = null
        alerts.cancel("join:$id")
        runCatching { api().cancelJoin(id) }
        joinAsks.value = joinAsks.value.filter { it.id != id }
        comparison.value = Comparison.Done(if (differed) "Refused $name: the digits differed." else "Refused $name.")
    }

    override fun closeComparison() {
        compareJob?.cancel()
        compared = null
        comparison.value = Comparison.Idle
    }

    override fun revoke(memberId: String) = run {
        if (memberId == me.id) throw IllegalArgumentException("Sign out to remove this phone.")
        syncDirectory()
        val entry = directories.revokeEntry(directory!!, me.id, signKey, memberId, now())
        api().append(entry)
        val all = saved.entries + ProtocolJson.encodeToJsonElement(entry)
        val after = directories.verify(all, saved.account, saved.pin)
        directory = after
        persist(saved.copy(entries = all, pin = Pin(after.length, after.head)))
    }

    /** Removes this phone from the directory, ends the session and forgets every key. */
    override fun signOut() = run {
        if (phase.value == Phase.Ready) {
            runCatching {
                syncDirectory()
                val dir = directory!!
                // The last device stays: removing it would leave only the recovery words.
                if (dir.active("device").size > 1) api().append(directories.revokeEntry(dir, me.id, signKey, me.id, now()))
            }
        }
        if (secrets.session != null) runCatching { api().logout() }
        wipe(null)
    }

    fun say(message: String) {
        notice.value = message
    }

    override fun dismissNotice() {
        notice.value = null
    }

    // --- To the screens' shapes --------------------------------------------------

    private fun instant(text: String?): Instant? = text?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() }

    private fun toUi(d: SavedDecision): Decision {
        val b = d.body
        return Decision(
            id = b.id,
            question = b.question,
            context = b.context,
            options = b.options,
            recommended = b.recommended,
            default = b.fallback?.action,
            defaultAt = instant(b.fallback?.at),
            source = Source(
                b.source.machine,
                b.source.project,
                b.source.session,
                b.source.sessionTitle,
                b.source.links.orEmpty().map { SessionLink(it.kind, it.url) },
                machineKind = b.source.machineKind,
            ),
            createdAt = instant(b.createdAt) ?: Instant.EPOCH,
            agent = b.agent,
            waiting = d.waiting == "waiting",
            waitingSince = if (d.waiting == "waiting") instant(d.waitingAt) else null,
            images = b.images.orEmpty().map { Image(it.data, it.width, it.height, it.alt) },
            links = b.links.orEmpty().map { Link(it.url, it.title) },
            answerIn = b.answerIn?.let { Link(it.url, it.title) },
            answer = d.answer,
            answeredAt = instant(d.answeredAt) ?: d.answer?.let { Instant.now() },
            settled = d.settled,
        )
    }

    /** How a prompt ended, in words, from this device's answer or the machine's notice. */
    private fun ended(p: SavedPrompt): String? {
        p.answer?.let { return if (it.startsWith("allow")) "Allowed here" else "Denied here" }
        val s = p.settled
        return when {
            s?.outcome == "keyboard" -> "Answered on ${p.body.source.machine}"
            s?.outcome == "timeout" -> "Timed out: left to the keyboard"
            s?.outcome == "device" && s.device == me.id -> "Answered here"
            s?.outcome == "device" -> "Answered from ${directory?.members?.get(s.device)?.member?.name ?: "another device"}"
            p.answeredAt != null -> "Answered on another device"
            else -> null
        }
    }

    private fun toUi(p: SavedPrompt): Prompt {
        val b = p.body
        return Prompt(
            id = b.id,
            tool = b.tool,
            summary = b.summary,
            description = b.description,
            input = b.input,
            scopes = b.suggestions.map { PromptScope(it.scope, it.label, it.rule) },
            source = Source(b.source.machine, b.source.project, b.source.session, b.source.sessionTitle, b.source.links.orEmpty().map { SessionLink(it.kind, it.url) }, b.source.machineKind),
            agent = b.agent,
            createdAt = instant(b.createdAt) ?: Instant.EPOCH,
            expiresAt = instant(b.expiresAt) ?: Instant.EPOCH,
            ended = ended(p),
            endedAt = instant(p.answeredAt),
        )
    }

    private fun toUi(q: SavedQuota, named: Boolean): List<QuotaWindow> = q.body.providers.flatMap { p ->
        p.windows.map { w ->
            // The card's state follows a pace alert; "low" only notifies.
            val alerts = q.body.alerts.filter { it.provider == p.provider && it.window == w.id && it.kind != "low" }
            val pace = w.pace
            val unused = alerts.firstOrNull { it.kind == "unused-headroom" }?.unusedPercent
            QuotaWindow(
                id = "${q.from}/${p.provider}/${w.id}",
                provider = p.provider,
                window = w.label.ifBlank { w.id },
                usedPercent = w.usedPercent.roundToInt(),
                resetsAt = instant(w.resetsAt),
                pace = paceOf(pace, unused),
                alert = alerts.isNotEmpty(),
                steadyPercent = pace?.expectedUsedPercent?.roundToInt()?.coerceIn(0, 100),
                windowMinutes = w.windowMinutes,
                machine = if (named) directory?.members?.get(q.from)?.member?.name ?: q.from else null,
                takenAt = instant(q.body.takenAt),
            )
        }
    }

    private fun toUi(r: SavedRun): Run {
        val b = r.body
        return Run(
            id = b.id,
            title = b.title,
            reason = b.reason,
            source = Source(b.source.machine, b.source.project, b.source.session, b.source.sessionTitle, b.source.links.orEmpty().map { SessionLink(it.kind, it.url) }, b.source.machineKind),
            startedAt = instant(b.startedAt) ?: Instant.EPOCH,
            at = instant(b.at) ?: Instant.EPOCH,
            progress = b.progress?.let { Run.Progress(it.done, it.total, it.unit == "percent") },
            exitCode = b.exit?.code,
            endedAt = instant(b.exit?.at),
        )
    }

    private fun toUi(dir: Directory): List<Member> {
        val added = saved.entries.mapNotNull { raw ->
            runCatching {
                val env = ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw)
                val body = ProtocolJson.decodeFromString(DirectoryEntry.serializer(), env.body)
                body.member?.id?.let { it to body.at }
            }.getOrNull()
        }.toMap()
        return dir.members.values.filter { it.active }.map { (m) ->
            Member(m.id, m.name, if (m.role == "machine") Kind.Machine else Kind.Device, instant(added[m.id]) ?: Instant.EPOCH, current = m.id == saved.me?.id)
        }
    }
}

private operator fun dev.starbridge.app.protocol.DirectoryMember.component1() = member

/**
 * A window's state, by the web's rule: "Headroom unused" only when the uploader raised an
 * unused-headroom alert for it, not whenever usage runs behind the steady pace.
 */
internal fun paceOf(pace: dev.starbridge.app.protocol.Pace?, unusedAlert: Double?): Pace = when {
    pace == null || pace.stage == "unknown" -> Pace.Unknown
    !pace.willLastToReset ->
        pace.runsOutAt?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() }?.let { Pace.RunsOut(it) } ?: Pace.Unknown
    unusedAlert != null -> Pace.Unused(unusedAlert.roundToInt())
    else -> Pace.Even
}

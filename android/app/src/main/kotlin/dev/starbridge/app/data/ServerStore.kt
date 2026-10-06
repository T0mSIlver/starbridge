package dev.starbridge.app.data

import android.util.Log
import dev.starbridge.app.protocol.Bip39
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.protocol.recoverySignSeed
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Directory
import dev.starbridge.app.protocol.DirectoryEntry
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.DirectoryHead
import dev.starbridge.app.protocol.Heads
import dev.starbridge.app.protocol.ItemBody
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
import kotlinx.coroutines.CancellationException
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
import kotlinx.serialization.json.putJsonObject
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
    /** A new question, or one whose agent flipped; a flip back to working is [silent]. */
    fun decision(decision: Decision, silent: Boolean = false)
    fun cancel(id: String)
    fun prompt(prompt: Prompt)
    fun cancelPrompt(prompt: Prompt)
    /** A browser or phone signed in to the account asks to join. */
    fun join(id: String, name: String)
    /** A run's newest update: shows, updates or ends its notification. */
    fun run(run: Run)
    /** Quota alerts the uploader newly raised; each shows once, if this phone opted in. */
    fun quota(notices: List<QuotaNotice>) {}
    /**
     * Signed out, or holding machines' items (#362): every notification goes, since they show
     * decrypted questions and commands and let the owner answer.
     */
    fun clearAll() {}
    /** An answer went out: shows it in place of the buttons. */
    fun answered(decision: Decision, answer: String) {}
    /** An answer waits for a connection. */
    fun queued(decision: Decision, answer: String) {}
    /** An answer the server refused; the buttons come back. */
    fun failed(decision: Decision, why: String) {}
}

/** What became of an answer: sent, waiting for a connection, answered elsewhere, or refused. */
sealed interface Sent {
    /** The server took this device's answer, now or before: a second tap lands here (#331). */
    data class Answered(val answer: String) : Sent
    /** Kept on the phone until the server can be reached; [AnswerWorker] sends it (#329). */
    data class Queued(val answer: String) : Sent
    data object Elsewhere : Sent
    data class Failed(val why: String) : Sent
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
    /** Asks for [flushAnswers] once a network is up; the app schedules [AnswerWorker]. */
    private val wakeWhenOnline: () -> Unit = {},
) : Store {
    private val lock = Mutex()
    private var saved = disk.saved() ?: Saved(defaultServer)
    private var secrets = disk.secrets()
    private var directory: Directory? = null
    private var pending: Pair<PairingCode, PairingRequestBody>? = null
    private var joinJob: Job? = null
    private var showJob: Job? = null
    private var watchJob: Job? = null
    private var pollJob: Job? = null

    /** A push reached this app since it started: the server can deliver, so nothing polls (#445). */
    @Volatile private var pushed = false

    /** How often the app in front reads the items while no push has arrived. */
    internal var pollMs = 10_000L
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
    private val headBook = Heads(directories)
    /** The hold notice last shown, so it goes once the hold ends. */
    @Volatile private var shownHold: String? = null
    override val sending = MutableStateFlow<Map<String, String>>(emptyMap())
    override val recovery = MutableStateFlow<RecoveryUi?>(null)
    override val replacing = MutableStateFlow<Replacing>(Replacing.Idle)
    /** While a new recovery key is on screen: its key pair, and the current one. */
    private var replacement: Pair<KeyPair, KeyPair>? = null
    /** Answers tapped but not yet sealed into [Saved.outbox]: the lock may be busy. */
    private val tapped = java.util.concurrent.ConcurrentHashMap<String, String>()

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
            saved.digitJoin != null -> Phase.JoiningByDigits(saved.digitJoin!!.digits, saved.digitJoin!!.matched)
            // Before the pin: the first entry waits on the server until the key is confirmed (#370).
            secrets.recoverySeed != null -> Phase.RecoveryKey(RecoveryKeys.shown(fromB64(secrets.recoverySeed!!), sodium))
            saved.me == null || saved.pin == null -> Phase.NoDevice(saved.accountExists)
            else -> Phase.Ready
        }
        server.value = saved.server
        push.value = push.value.copy(type = saved.pushType, registered = saved.push?.type == saved.pushType)
        // While the server holds back entries a machine has seen, no machine's item shows (#362).
        val held = withheld() != null
        // A hold that ended takes its notice with it; only a confirmed one raises it.
        if (!held && notice.value != null && notice.value == shownHold) notice.value = null
        // A revoked machine's items leave, as on the web: nothing it asked can be answered (#344).
        fun active(from: String) = directory?.members?.get(from)?.active != false
        decisions.value = if (held) emptyList() else saved.decisions.filter { active(it.from) }.map(::toUi)
        prompts.value = if (held) emptyList() else saved.prompts.filter { active(it.from) }.map(::toUi)
        // As the web: named once the account has more than one active machine.
        val named = (directory?.members?.values?.count { it.active && it.member.role == "machine" } ?: 0) > 1
        windows.value = if (held) emptyList() else saved.quotas.filter { active(it.from) }.flatMap { toUi(it, named) }
        runs.value = if (held) emptyList() else saved.runs.filter { active(it.from) }.map(::toUi)
        members.value = directory?.let(::toUi).orEmpty()
        recovery.value = directory?.let(::recoveryUi)
        showSending()
    }

    private fun showSending() {
        sending.value = saved.outbox.associate { it.decisionId to it.answer } + tapped
    }

    fun setDistributors(list: List<String>) {
        push.value = push.value.copy(distributors = list)
    }

    /** Runs [block] off the caller, one at a time, and turns failures into a notice. */
    private fun run(showBusy: Boolean = true, block: suspend () -> Unit) {
        scope.launch { locked(showBusy, block) }
    }

    // A run the owner sees raises busy before it waits for the lock: a pull during a quiet sync
    // shows at once. Quiet runs, such as the prompt poll, leave it alone.
    private suspend fun locked(showBusy: Boolean = true, block: suspend () -> Unit) = shown(showBusy) {
        lock.withLock {
            try {
                block()
            } catch (e: Exception) {
                report(e)
            }
        }
    }

    /** Counts the shown runs under way; [busy] holds while any is. */
    private var shownRuns = 0

    private inline fun <T> shown(on: Boolean, block: () -> T): T {
        if (!on) return block()
        synchronized(this) { busy.value = ++shownRuns > 0 }
        try {
            return block()
        } finally {
            synchronized(this) { busy.value = --shownRuns > 0 }
        }
    }

    private fun report(e: Exception) {
        // With the exception in the message: Android drops the trace of an UnknownHostException.
        Log.w("Starbridge", "failed: $e", e)
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
        // Another account's key, or this account's from before a replacement (#348).
        is ProtocolException if e.code == "wrong-recovery-key" -> "This is a recovery key, but not this account's current one."
        is ProtocolException -> "Refused: the server sent something that does not check out (${e.code})."
        is IOException -> "Can't reach ${saved.server}: ${e.message}"
        else -> e.message ?: e.toString()
    }

    private fun wipe(message: String?) {
        // Another account or server may have no push: poll again until one arrives.
        pushed = false
        joinJob?.cancel()
        showJob?.cancel()
        watchJob?.cancel()
        compareJob?.cancel()
        compared = null
        joinAsks.value = emptyList()
        comparison.value = Comparison.Idle
        disk.wipe()
        alerts.clearAll()
        pendingPush = null
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
        persist(saved.copy(account = me.account, accountExists = exists, me = null, pin = null, entries = emptyList(), heads = emptyMap()))
    }

    private fun newMember(): DirectoryMember {
        val boxKeys = sodium.boxKeyPair()
        val signKeys = sodium.signKeyPair()
        val member = DirectoryMember(newId("d_"), "device", deviceName.take(100).ifBlank { "Android" }, toB64(boxKeys.public), toB64(signKeys.public))
        // The keys reach the disk before the server hears of them, so a crash cannot strand them.
        // New keys end any recovery attempt that made the ones they replace.
        persist(saved.copy(recovering = null), secrets.copy(boxPk = member.boxPk, boxSk = toB64(boxKeys.secret), signPk = member.signPk, signSk = toB64(signKeys.secret)))
        return member
    }

    /**
     * Makes the keys, the seed and the signed first entry, all on disk, and shows the recovery key.
     * The server sees the entry only once the owner confirms the key (#370, as the web since #337):
     * data cleared before that leaves no account without a device, and a killed app shows the
     * same key again.
     */
    override fun setUpFirstDevice() = run {
        if (saved.pendingGenesis != null) return@run
        if (api().directory(0).isNotEmpty()) throw IllegalStateException("This account already has devices. Join it instead.")
        val member = newMember()
        val seed = sodium.random(16)
        val recovery = sodium.signSeedKeyPair(recoverySignSeed(seed, sodium))
        val entry = ProtocolJson.encodeToJsonElement(directories.genesisEntry(saved.account!!, member, signKey, recovery, now()))
        persist(saved.copy(me = member, pin = null, pendingGenesis = entry), secrets.copy(recoverySeed = toB64(seed)))
    }

    /**
     * Posts the first entry kept on disk, so a lost response is retried with the same entry, and
     * a chain that already starts with it is adopted instead of refused.
     */
    private suspend fun postFirstEntry() {
        val genesis: JsonElement = saved.pendingGenesis!!
        val existing = api().directory(0)
        if (existing.isEmpty()) api().append(ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), genesis))
        else if (existing.first() != genesis) {
            // Another device set the account up meanwhile: this setup's key was never used.
            persist(saved.copy(me = null, pendingGenesis = null, accountExists = true), Secrets(session = secrets.session))
            throw IllegalStateException("This account already has devices. Join it instead.")
        } else if (api().me().member == null) {
            // The server took the entry but the session that posted it is gone: bind this one.
            api().bind(me.id, toB64(sodium.sign(bindMessage(saved.account!!, me.id, api().challenge()), signKey)))
        }
        val entries = listOf(genesis)
        val dir = directories.verify(entries, saved.account)
        directory = dir
        persist(saved.copy(entries = entries, pin = Pin(dir.length, dir.head), pendingGenesis = null))
    }

    override fun confirmRecoveryKey() = run {
        if (saved.pendingGenesis != null) postFirstEntry()
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

    override fun confirmDigits() = run {
        val dj = saved.digitJoin ?: return@run
        if (dj.digits == null) return@run
        persist(saved.copy(digitJoin = dj.copy(matched = true)))
        // From the start: an approval that came before the owner confirmed is read again.
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
                // A restarted wait cancels this one, which is no reason to drop the join.
                if (e is CancellationException) throw e
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
        // The approval's MAC proves only that whoever sent the approver key approved, which may be
        // the server: it counts once this phone's owner has seen the digits match (#355).
        if (!dj.matched) return false
        if (body.account != saved.account) throw ProtocolException("wrong-account", body.account)
        val entries = api().directory(0)
        val dir = directories.verify(entries, saved.account, Pin(body.length, body.head))
        checkJoined(dir, me)
        directory = dir
        persist(saved.copy(digitJoin = null, entries = entries, pin = Pin(dir.length, dir.head)), secrets.copy(joinPk = null, joinSk = null))
        return true
    }

    override fun recover(words: String) = run {
        val recovery = sodium.signSeedKeyPair(recoverySignSeed(RecoveryKeys.seed(words, sodium), sodium))
        val entries = api().directory(0)
        // The chain's current recovery key must be this one, whose own signature a server cannot
        // fake; a phone that was a device before keeps the server from serving it a shorter chain.
        val dir = directories.verify(entries, saved.account, saved.pin, recoveryPk = toB64(recovery.public))
        // The keys made for an earlier attempt stay until the chain holds them: when its reply was
        // lost, the server has bound the session to that member, and a retry finds it there (#274).
        // Only while those keys are still this phone's, and the member was not revoked since.
        val earlier = saved.recovering?.takeIf { it.signPk == secrets.signPk && it.boxPk == secrets.boxPk && dir.members[it.id]?.active != false }
        val member = earlier ?: newMember().also { persist(saved.copy(recovering = it)) }
        val all = if (dir.members[member.id]?.active == true) {
            entries
        } else {
            // Revokes every other member: recovery means they are lost, or in someone else's hands (#363).
            val entry = directories.recoverEntry(dir, recovery.secret, member, now())
            api().append(entry)
            entries + ProtocolJson.encodeToJsonElement(entry)
        }
        val after = directories.verify(all, saved.account, Pin(dir.length, dir.head))
        directory = after
        persist(saved.copy(me = member, recovering = null, entries = all, pin = Pin(after.length, after.head)))
        // A session an abandoned attempt's append bound to its member cannot act as this one, and
        // the server never moves it: signing in again binds a new one to this phone's keys.
        val bound = runCatching { api().me().member }.getOrNull()
        if (bound != null && bound != member.id) {
            persist(newSecrets = secrets.copy(session = null))
            notice.value = "Sign in again to finish recovering. This phone keeps its keys."
            return@run
        }
        sync()
    }

    // --- Syncing -----------------------------------------------------------------

    override fun refresh(shown: Boolean) = run(showBusy = shown) { sync() }

    // Outside the lock: the machines take seconds to post, and answers must not wait on them.
    override fun refreshQuotas() {
        scope.launch {
            shown(true) {
                try {
                    if (phase.value == Phase.Ready) api().askQuota(QUOTA_ASK_SECONDS)
                } catch (e: ApiException) {
                    // Asked too often, or a server without asks: the sync shows what it holds.
                } catch (e: IOException) {
                    // Offline: the sync reports it.
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Nothing may escape this coroutine: it would end the app (#253).
                    Log.w("Starbridge", "quota ask failed: $e", e)
                }
                // Not `run`: inside launch it resolves to the standard library's, which never
                // clears busy and lets a failed sync escape (#303).
                locked { sync() }
            }
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
        if (saved.outbox.isNotEmpty()) flushHeld()
        // The server answered, so a push route that failed to register gets another try.
        pendingPush?.let { runCatching { subscribeHeld(it) } }
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
        closeRevoked(dir)
        persist(saved.copy(entries = all, pin = Pin(dir.length, dir.head)))
    }

    /** Closes the notifications of revoked machines' questions and prompts: no answer reaches them. */
    private fun closeRevoked(dir: Directory) {
        for (d in saved.decisions) if (dir.members[d.from]?.active == false) alerts.cancel(d.body.id)
        for (p in saved.prompts) if (dir.members[p.from]?.active == false) alerts.cancelPrompt(toUi(p))
    }

    /**
     * Opens a machine's item and keeps the directory head it signed. Refuses every item while a
     * head an active machine signed is missing from this phone's chain (#362).
     */
    private fun open(item: SealedItem): Pair<String, Any>? = try {
        // Null once a directory read found this phone removed (wipe).
        val dir = directory ?: throw ProtocolException("no-directory", "")
        val opened = envelopes.open(item, me.id, box, dir)
        keepHead(item.from, (opened.body as? ItemBody)?.dir)
        if (withheld() != null) null else item.from to opened.body
    } catch (e: ProtocolException) {
        // Not shown: an item that fails its checks is the server's or a stranger's.
        Log.w("Starbridge", "dropped ${item.kind} ${item.id}: ${e.message}")
        null
    }

    private fun keepHead(machine: String, head: DirectoryHead?) {
        val heads = saved.heads.toMutableMap()
        if (headBook.note(heads, machine, head, saved.entries, directory)) persist(saved.copy(heads = heads))
    }

    /**
     * Why no machine's item counts: the server holds back entries a machine has seen. It names the
     * machine and, for a head it passed on, the device; a compromised machine can name any device,
     * the owner's own phone included, so the machine is the one to revoke first.
     */
    private fun withheld(): String? {
        val dir = directory ?: return null
        val held = headBook.withheldBy(saved.heads, dir, saved.entries) ?: return null
        fun name(id: String) = dir.members[id]?.member?.name ?: id
        val machine = name(held.id)
        val seen = held.by?.let { "$machine says ${name(it)} has seen changes to your devices that the server is holding back." }
            ?: "The server is holding back changes to your devices that $machine has seen."
        return "$seen Nothing from your machines shows until it sends them. If this does not clear, revoke $machine first."
    }

    /**
     * On the first sign of a hold, reads the directory once more: a machine may only have signed
     * an entry made on another device since this phone's last read. True while the hold remains,
     * which says why and closes the notifications, since they would still offer answers.
     */
    private suspend fun confirmHold(): Boolean {
        if (withheld() == null) return false
        syncDirectory()
        // Removed from the devices: the wipe said why, and nothing more opens.
        if (phase.value != Phase.Ready) return true
        val why = withheld() ?: return false
        notice.value = why
        shownHold = why
        alerts.clearAll()
        return true
    }

    /** Keeps the heads of [items] before any counts, so the one that shows a gap holds back the rest. */
    private suspend fun scan(items: List<SealedItem>): Boolean {
        items.forEach { open(it) }
        return confirmHold()
    }

    /**
     * Before a pushed item opens: reads the directory when the sender is new to this phone, or
     * when the head it signed shows entries the phone lacks.
     */
    private suspend fun catchUp(item: SealedItem) {
        if (directory?.members?.containsKey(item.from) != true) syncDirectory()
        open(item)
        confirmHold()
    }

    private suspend fun syncDecisions() {
        // Saved by an app that dropped fields it did not know: read every open one again.
        val reread = saved.decisionFields < DECISION_FIELDS
        var cursor = if (reread) "" else saved.cursor
        val byId = saved.decisions.associateBy { it.body.id }.toMutableMap()
        // How each item a settled notice closed was closed, with the time: the notice lists before
        // the decision it closed, which moved past it.
        val closings = mutableMapOf<String, Pair<String?, String>>()
        // Which device's answer each machine took, whenever its notice comes (#330).
        val wins = mutableListOf<Pair<String, Settled>>()
        val waits = mutableListOf<Pair<String, Waiting>>()
        while (true) {
            val page = api().items("decision,settled,waiting", cursor)
            // Held: the cursor stays, so these items are read again once the hold ends.
            if (scan(page.items.map { it.item })) return
            for (listed in page.items) {
                if (listed.item.kind == "waiting") {
                    val (from, body) = open(listed.item) ?: continue
                    waits += from to body as Waiting
                    continue
                }
                if (listed.item.kind == "settled") {
                    val (from, body) = open(listed.item) ?: continue
                    body as Settled
                    if (body.outcome == "device") wins += from to body
                    // Keyed by machine: a notice closes only the machine's own items (#362).
                    else closings["$from/${body.itemId}"] = body.outcome to listed.receivedAt
                    continue
                }
                // The notice that closed it arrived in the same write, so it carries the same time;
                // a later one, after a device's answer, closed nothing.
                fun settledBy(machine: String) = closings["$machine/${listed.item.id}"]?.takeIf { it.second == listed.answeredAt }?.first
                val known = byId[listed.item.id]
                if (known != null && reread && known.answeredAt == null && listed.answeredAt == null) {
                    val (from, body) = open(listed.item) ?: continue
                    if (from == known.from) byId[known.body.id] = known.copy(body = body as DecisionBody)
                    continue
                }
                if (known != null) {
                    // A settled push marked it answered already, without saying how.
                    val settled = settledBy(known.from)
                    if (listed.answeredAt != null && (known.answeredAt == null || settled != null)) {
                        byId[known.body.id] = known.copy(answeredAt = listed.answeredAt, settled = settled ?: known.settled)
                        alerts.cancel(known.body.id)
                    }
                    continue
                }
                val (from, body) = open(listed.item) ?: continue
                byId[listed.item.id] = SavedDecision(from, body as DecisionBody, listed.answeredAt, settled = settledBy(from))
            }
            cursor = page.cursor
            if (page.items.size < 100) break
        }
        // An update may list before the decision it is about, so they apply once all are read.
        for ((from, w) in waits) byId[w.decisionId]?.let { d -> wait(d, from, w)?.let { byId[w.decisionId] = it } }
        for ((from, n) in wins) byId[n.itemId]?.let { d -> won(d, from, n)?.let { byId[n.itemId] = it } }
        persist(saved.copy(cursor = cursor, decisions = byId.values.sortedBy { it.body.createdAt }.takeLast(500), decisionFields = DECISION_FIELDS))
    }

    /**
     * [d] with the agent's waiting state from [w], or null when [w] changes nothing: it must come
     * from the machine that asked, and only a later update replaces an earlier one.
     */
    /** Fetches decision [id] and keeps it; null when it does not open. */
    private suspend fun fetchDecision(id: String): SavedDecision? {
        val listed = api().item(id)
        if (directory?.members?.containsKey(listed.item.from) != true) syncDirectory()
        val (from, body) = open(listed.item) ?: return null
        val d = SavedDecision(from, body as DecisionBody, listed.answeredAt)
        persist(saved.copy(decisions = saved.decisions + d))
        return d
    }

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
        if (scan(read.map { it.item })) return
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
                    settleDecision(notice.itemId, from, notice)
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
    private fun settleDecision(id: String, from: String, notice: Settled) {
        val d = saved.decisions.find { it.body.id == id && it.from == from } ?: return
        alerts.cancel(id)
        val updated = if (notice.outcome == "device") won(d, from, notice)
        else if (d.answeredAt == null && d.answer == null) d.copy(answeredAt = now(), settled = notice.outcome)
        else null
        if (updated != null) persist(saved.copy(decisions = saved.decisions.map { if (it === d) updated else it }))
    }

    /** Decisions this phone's answer lost to another device's, until the machine says which won. */
    private val lost = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /**
     * [d] answered with the other device's answer the asking machine's notice names, or null when
     * the notice is not the asking machine's, names this phone, or carries no answer (#330).
     */
    private fun won(d: SavedDecision, from: String, n: Settled): SavedDecision? {
        val answer = n.choice ?: n.text ?: return null
        if (d.from != from || n.device == null || n.device == me.id || d.answer != null) return null
        if (lost.remove(d.body.id)) notice.value = answeredFirst(answer, n.device)
        return d.copy(answeredAt = d.answeredAt ?: now(), theirAnswer = answer, answeredBy = n.device)
    }

    private fun answeredFirst(answer: String, device: String) =
        "Answered on ${directory?.members?.get(device)?.member?.name ?: device}: $answer"

    /** Keeps a week of prompts, the log's span, as the server does. */
    private fun keepPrompts(byId: Map<String, SavedPrompt>, cursor: String = saved.promptCursor) {
        val weekAgo = Instant.now().minus(7, ChronoUnit.DAYS)
        val kept = byId.values.filter { instant(it.body.createdAt)?.isAfter(weekAgo) != false }.sortedBy { it.body.createdAt }
        persist(saved.copy(promptCursor = cursor, prompts = kept))
    }

    /**
     * The inbox's quick read while a prompt shows. After a failure (offline, say) it waits 3 s,
     * then twice as long after each further one, up to a minute, instead of retrying every 1.5 s.
     */
    override fun refreshPrompts() {
        if (System.currentTimeMillis() < promptsRetryAt) return
        run(showBusy = false) {
            if (phase.value != Phase.Ready) return@run
            try {
                syncPrompts()
                promptFailures = 0
            } catch (e: Exception) {
                promptFailures++
                promptsRetryAt = System.currentTimeMillis() + minOf(60_000L, 1_500L shl promptFailures.coerceAtMost(6))
                throw e
            }
        }
    }

    @Volatile private var promptFailures = 0
    @Volatile private var promptsRetryAt = 0L

    override fun refreshDirectory() = run(showBusy = false) {
        if (phase.value == Phase.Ready) syncDirectory()
    }

    override fun answerPrompt(id: String, allow: Boolean, scope: String, message: String?) =
        run(showBusy = false) { sendPrompt(id, allow, scope, message) }

    /**
     * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
     * asked. A deny is for this call only; a wider allow only for a scope the prompt offered.
     */
    suspend fun sendPrompt(id: String, allow: Boolean, scope: String, message: String?) {
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
            if (!allow) message?.trim()?.takeIf { it.isNotEmpty() }?.let { put("message", it.take(500)) }
            // Lets the machine notice a server holding back entries, such as a revocation.
            directory?.let { d -> putJsonObject("dir") { put("length", d.length); put("head", d.head) } }
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
        val listed = api().quota()
        if (scan(listed.map { it.item })) return
        val quotas = listed.mapNotNull { open(it.item)?.let { (from, body) -> SavedQuota(from, body as QuotaSnapshot) } }
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
            if (scan(page.items.map { it.item })) return
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

    /**
     * One answer per decision: the decision stays locked until the server takes it, which may
     * wait for a connection (#329).
     */
    override fun answer(id: String, choice: String?, text: String?) {
        if (id in sending.value) return
        tapped[id] = choice ?: text.orEmpty()
        showSending()
        run(showBusy = false) {
            try {
                when (val sent = send(id, choice, text)) {
                    is Sent.Queued -> notice.value = "No connection. ${sent.answer} will be sent when the phone is back online."
                    Sent.Elsewhere -> {
                        val d = saved.decisions.find { it.body.id == id }
                        val by = d?.answeredBy
                        val theirs = d?.theirAnswer
                        if (by != null && theirs != null) notice.value = answeredFirst(theirs, by)
                        else {
                            lost += id
                            notice.value = "Already answered on another device."
                        }
                    }
                    is Sent.Failed -> notice.value = "Not sent: ${sent.why}"
                    is Sent.Answered -> Unit
                }
            } finally {
                tapped.remove(id)
                showSending()
            }
        }
    }

    /**
     * Signs the answer, seals it to the machine that asked, the only recipient the server
     * accepts, and keeps it in [Saved.outbox] before posting it, so an answer tapped offline is
     * sent once the server can be reached. Tapping again repeats the first answer's outcome.
     * The notification's buttons call this too.
     */
    suspend fun send(id: String, choice: String?, text: String?): Sent {
        // Not even an answer queued before: its machine may be the one the server keeps revoked.
        withheld()?.let { return Sent.Failed(it) }
        saved.outbox.find { it.decisionId == id }?.let { return post(it) }
        val d = saved.decisions.find { it.body.id == id } ?: throw IllegalStateException("No such decision.")
        d.answer?.let { return Sent.Answered(it) }
        if (d.answeredAt != null) return Sent.Elsewhere
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
            // Lets the machine notice a server holding back entries, such as a revocation.
            directory?.let { d -> putJsonObject("dir") { put("length", d.length); put("head", d.head) } }
        }
        val queued = QueuedAnswer(id, choice ?: text!!, envelopes.seal("answer", body, me.id, signKey, listOf(machine)))
        persist(saved.copy(outbox = saved.outbox + queued))
        return post(queued)
    }

    /** Posts a queued answer and settles it, or keeps it for [wakeWhenOnline] to send later. */
    private suspend fun post(q: QueuedAnswer): Sent {
        try {
            api().postItem(q.item)
        } catch (e: CancellationException) {
            // Cut off mid-request, by the notification's time limit say: it may have landed.
            keep(q, landed = true)
            throw e
        } catch (e: ApiException) {
            return when {
                e.error == "already-answered" -> {
                    // A retry of an answer the server took before its reply was lost finds the
                    // decision answered; the server can't say by whom, so this guesses ours.
                    settle(q, if (q.mayHaveLanded) q.answer else null)
                    if (q.mayHaveLanded) Sent.Answered(q.answer) else Sent.Elsewhere
                }
                // The session ended: report() asks to sign in again, and the answer waits for it.
                e.status == 401 -> {
                    keep(q, landed = false)
                    throw e
                }
                e.status >= 500 || e.status == 429 -> {
                    keep(q, landed = e.status != 502 && e.status != 503 && e.status != 429)
                    Sent.Queued(q.answer)
                }
                else -> {
                    persist(saved.copy(outbox = saved.outbox.filter { it.decisionId != q.decisionId }))
                    Sent.Failed(describe(e))
                }
            }
        } catch (e: IOException) {
            // No route or no name: the request never left. Anything else may have reached it.
            keep(q, landed = e !is java.net.ConnectException && e !is java.net.UnknownHostException && e !is java.net.NoRouteToHostException)
            return Sent.Queued(q.answer)
        }
        settle(q, q.answer)
        return Sent.Answered(q.answer)
    }

    private fun keep(q: QueuedAnswer, landed: Boolean) {
        if (landed && !q.mayHaveLanded) {
            persist(saved.copy(outbox = saved.outbox.map { if (it.decisionId == q.decisionId) it.copy(mayHaveLanded = true) else it }))
        }
        wakeWhenOnline()
    }

    /** Takes the answer out of the outbox and marks its decision answered, by this device when [answer] is set. */
    private fun settle(q: QueuedAnswer, answer: String?) {
        persist(
            saved.copy(
                outbox = saved.outbox.filter { it.decisionId != q.decisionId },
                decisions = saved.decisions.map { if (it.body.id == q.decisionId) it.copy(answeredAt = now(), answer = answer) else it },
            ),
        )
    }

    /** For the notification's buttons: holds the lock like any other change. */
    suspend fun sendFromNotification(id: String, choice: String?, text: String?) = lock.withLock { send(id, choice, text) }

    /** The answer waiting to be sent for decision [id], if any. */
    fun queued(id: String): String? = saved.outbox.find { it.decisionId == id }?.answer

    /**
     * Sends the queued answers, oldest first, and tells the notifications how each ended. False
     * while some still wait, so [AnswerWorker] tries again later.
     */
    suspend fun flushAnswers(): Boolean = lock.withLock {
        if (phase.value != Phase.Ready) return@withLock true
        try {
            flushHeld() && saved.outbox.isEmpty()
        } catch (e: IOException) {
            report(e)
            false
        }
    }

    private suspend fun flushHeld(): Boolean {
        // Kept, and tried again once the hold ends.
        if (withheld() != null) return false
        for (q in saved.outbox) {
            val decision = decisions.value.find { it.id == q.decisionId }
            when (val sent = post(q)) {
                is Sent.Queued -> return false
                is Sent.Answered -> decision?.let { alerts.answered(it, sent.answer) }
                Sent.Elsewhere -> alerts.cancel(q.decisionId)
                is Sent.Failed -> {
                    notice.value = "Not sent: ${sent.why}"
                    decision?.let { alerts.failed(it, sent.why) }
                }
            }
        }
        return true
    }

    // --- Push --------------------------------------------------------------------

    /**
     * A push payload (PROTOCOL.md, "Push"): a new item with this device's box when it fits, else
     * its id to fetch; or `answered` once a decision is answered anywhere.
     */
    suspend fun onPush(payload: String): Unit {
        // Before the lock: a push that times out waiting for a poll still counts.
        pushed = true
        onPushHeld(payload)
    }

    private suspend fun onPushHeld(payload: String) = lock.withLock {
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
                catchUp(item)
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
                catchUp(item)
                val byId = saved.prompts.associateBy { it.body.id }.toMutableMap()
                val added = takePrompt(item, answeredAt, byId)
                keepPrompts(byId)
                if (added != null && added.answeredAt == null) alerts.prompt(toUi(added))
            }
            "waiting" -> {
                // Pushed when the agent flips: to waiting re-notifies once, back to working moves
                // the notification silently (#191). A question asked already waiting pushes only
                // this, so its decision may be new here.
                val box = p["box"]?.jsonPrimitive?.content
                val item = if (box != null) {
                    SealedItem(1, "waiting", id, p.getValue("from").jsonPrimitive.content, p["re"]?.jsonPrimitive?.content, listOf(SealedBox(me.id, box)))
                } else {
                    api().item(id).item
                }
                catchUp(item)
                val (from, body) = open(item) ?: return@withLock
                body as Waiting
                val d = saved.decisions.find { it.body.id == body.decisionId } ?: fetchDecision(body.decisionId) ?: return@withLock
                val updated = wait(d, from, body) ?: return@withLock
                persist(saved.copy(decisions = saved.decisions.map { if (it === d) updated else it }))
                if (d.answeredAt == null && d.answer == null && (d.waiting == "waiting") != (updated.waiting == "waiting")) {
                    alerts.decision(toUi(updated), silent = updated.waiting != "waiting")
                }
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
                catchUp(item)
                val (from, body) = open(item) ?: return@withLock
                keepRuns(listOf(SavedRun(from, body as RunBody)))
            }
        }
    }

    /** Registers where pushes go; a new endpoint replaces the old subscription. */
    suspend fun subscribe(type: String, endpoint: String, keys: Pair<String, String>?) = lock.withLock { subscribeHeld(PushRoute(type, endpoint, keys)) }

    /** Registers a route that failed earlier, offline say: on a new network, and after each sync (#274). */
    suspend fun retryPush() = lock.withLock { pendingPush?.let { runCatching { subscribeHeld(it) } } }

    private class PushRoute(val type: String, val endpoint: String, val keys: Pair<String, String>?)

    /** The route whose registration failed, kept until one succeeds or the phone signs out. */
    @Volatile private var pendingPush: PushRoute? = null

    private suspend fun subscribeHeld(route: PushRoute) {
        if (phase.value != Phase.Ready || route.type != saved.pushType) return
        val old = saved.push
        if (old != null && old.type == route.type && old.endpoint == route.endpoint) {
            pendingPush = null
            return
        }
        pendingPush = route
        if (old != null) {
            runCatching { api().unsubscribe(old.id) }
            // Forgotten first, so a failed replacement is not mistaken for a working route.
            persist(saved.copy(push = null))
        }
        val id = api().subscribe(route.type, route.endpoint, route.keys)
        persist(saved.copy(push = SavedPush(route.type, id, route.endpoint)))
        pendingPush = null
    }

    override fun setPushType(type: String) = run(showBusy = false) {
        // A new route has yet to prove it delivers.
        pushed = false
        persist(saved.copy(pushType = type))
    }

    // --- Pairing and revoking ----------------------------------------------------

    override fun lookUpPairing(code: String) = run(showBusy = false) {
        // A shown QR code's wait must not overwrite the request looked up now.
        showJob?.cancel()
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

    /**
     * While the app is in front and no push has reached it, reads the items every [pollMs]: a
     * server without a relay or UnifiedPush sends none, and the Inbox would never change (#445).
     * Quiet: a failed read leaves no notice, since the next one, or the owner's pull, says why.
     */
    override fun foreground(on: Boolean) {
        pollJob?.cancel()
        if (!on) return
        pollJob = scope.launch {
            while (true) {
                delay(pollMs)
                if (pushed || phase.value != Phase.Ready) continue
                lock.withLock {
                    try {
                        sync()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // An ended session says so at once, and stops the reads that fail with it.
                        if (e is ApiException && e.status == 401) report(e) else Log.w("Starbridge", "poll failed: $e")
                    }
                }
            }
        }
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
        closeRevoked(after)
        persist(saved.copy(entries = all, pin = Pin(after.length, after.head)))
    }

    // --- Replacing the recovery key (#348) -------------------------------------------------

    override fun newRecoveryKey(currentKey: String) = run {
        syncDirectory()
        // Both keys sign, so neither a stolen phone nor a leaked key replaces it alone.
        val typed = RecoveryKeys.seed(currentKey, sodium)
        val signSeed = recoverySignSeed(typed, sodium)
        val current = sodium.signSeedKeyPair(signSeed)
        typed.fill(0)
        signSeed.fill(0)
        if (toB64(current.public) != directory!!.recoveryPk) {
            current.secret.fill(0)
            throw IllegalArgumentException("This isn't the account's current recovery key.")
        }
        val seed = sodium.random(16)
        val nextSeed = recoverySignSeed(seed, sodium)
        val next = sodium.signSeedKeyPair(nextSeed)
        val shown = RecoveryKeys.shown(seed, sodium)
        seed.fill(0)
        nextSeed.fill(0)
        dropReplacement()
        replacement = next to current
        replacing.value = Replacing.Shown(shown)
    }

    // The new key reaches the directory only now, once the owner says it is saved (#328).
    override fun saveRecoveryKey() = run {
        val shown = replacing.value as? Replacing.Shown ?: return@run
        val (next, current) = replacement ?: return@run
        replacing.value = shown.copy(saving = true)
        try {
            syncDirectory()
            // A recovery or a revocation removed this phone: the sync wiped it and said so.
            if (saved.me == null) {
                dropReplacement()
                replacing.value = Replacing.Idle
                return@run
            }
            val nextPk = toB64(next.public)
            // Another device replaced the key since it was typed: the confirmation could never verify.
            if (directory!!.recoveryPk != nextPk && directory!!.recoveryPk != toB64(current.public)) {
                throw IllegalStateException("Another device replaced the recovery key meanwhile. Start again.")
            }
            if (directory!!.recoveryPk != nextPk) {
                // A retry after the proposal landed confirms it rather than proposing it again; one
                // another proposal replaced meanwhile can never be posted again.
                val pending = directory!!.pendingRecovery?.recoveryPk
                if (pending != nextPk && nextPk in directory!!.recoveryPks) throw IllegalStateException("Another device proposed a new key meanwhile. Start again.")
                if (pending != nextPk) appendEntry { directories.recoveryEntry(it, me.id, signKey, next, now()) }
                appendEntry { directories.recoveryConfirmEntry(it, current.secret, nextPk, now()) }
            }
        } catch (e: Exception) {
            replacing.value = shown
            throw e
        }
        dropReplacement()
        replacing.value = Replacing.Done
    }

    override fun closeRecoveryKey() {
        // Not while a save signs with the keys: it ends in Done, or back on the key to retry.
        if ((replacing.value as? Replacing.Shown)?.saving == true) return
        dropReplacement()
        replacing.value = Replacing.Idle
    }

    override fun dismissRecoveryNotice(seq: Int) = run(showBusy = false) { persist(saved.copy(recoverySeen = seq)) }

    private fun dropReplacement() {
        replacement?.let { (next, current) ->
            next.secret.fill(0)
            current.secret.fill(0)
        }
        replacement = null
    }

    /** Appends the entry [make] signs on the current chain, and moves the pin to it. */
    private suspend fun appendEntry(make: (Directory) -> SignedEnvelope) {
        val entry = make(directory!!)
        api().append(entry)
        val all = saved.entries + ProtocolJson.encodeToJsonElement(entry)
        val after = directories.verify(all, saved.account, saved.pin)
        directory = after
        persist(saved.copy(entries = all, pin = Pin(after.length, after.head)))
    }

    private fun recoveryUi(dir: Directory): RecoveryUi {
        val mine = saved.me?.id
        fun name(id: String) = if (id == mine) "this phone" else dir.members[id]?.member?.name ?: id
        val joined = saved.entries.indexOfFirst { raw ->
            runCatching {
                val env = ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw)
                ProtocolJson.decodeFromString(DirectoryEntry.serializer(), env.body).let { (it.op == "add" || it.op == "recover") && it.member?.id == mine }
            }.getOrDefault(false)
        }
        val set = dir.recoverySet
        val fresh = set.seq > 0 && set.seq > joined && set.seq > saved.recoverySeen && set.by != mine
        return RecoveryUi(
            setAt = instant(set.at) ?: Instant.EPOCH,
            setBy = name(set.by),
            replaced = set.seq > 0,
            notice = if (fresh) RecoveryNotice(set.seq, instant(set.at) ?: Instant.EPOCH, name(set.by)) else null,
        )
    }

    /** Removes this phone from the directory, ends the session and forgets every key. */
    override fun signOut() = run {
        if (phase.value == Phase.Ready) {
            runCatching {
                syncDirectory()
                val dir = directory!!
                // The last device stays: removing it would leave only the recovery key.
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
            theirAnswer = d.theirAnswer,
            answeredOn = d.answeredBy?.let { directory?.members?.get(it)?.member?.name ?: it },
            replies = b.replies == true,
        )
    }

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
                takenAt = instant(p.updatedAt ?: q.body.takenAt),
                error = p.error,
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

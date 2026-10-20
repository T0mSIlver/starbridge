package dev.starbridge.app.data

import android.util.Log
import dev.starbridge.app.protocol.Images
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.protocol.recoverySignSeed
import dev.starbridge.app.protocol.isItemId
import dev.starbridge.app.protocol.isPushKind
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Directory
import dev.starbridge.app.protocol.DirectoryEntry
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.DirectoryHead
import dev.starbridge.app.protocol.Heads
import dev.starbridge.app.protocol.Withheld
import dev.starbridge.app.protocol.ItemBody
import dev.starbridge.app.protocol.JoinRequestBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.KeyPair
import dev.starbridge.app.protocol.PairingApprovalBody
import dev.starbridge.app.protocol.PairingCode
import dev.starbridge.app.protocol.PairingRequestBody
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolException
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.SealedBox
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.SIGNER_ROLE
import dev.starbridge.app.protocol.SignedEnvelope
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.bindMessage
import dev.starbridge.app.protocol.checkJoined
import dev.starbridge.app.protocol.checkKeyFromLink
import dev.starbridge.app.protocol.codeFromLink
import dev.starbridge.app.protocol.otherServer
import dev.starbridge.app.protocol.fromB64
import dev.starbridge.app.protocol.pairingLink
import dev.starbridge.app.protocol.parsePairingCode
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URI
import java.time.Instant
import java.time.temporal.ChronoUnit
import dev.starbridge.app.protocol.Member as DirectoryMember
import dev.starbridge.app.protocol.takeCodePoints

/** Shows and clears notifications; the app's is [dev.starbridge.app.push.Notifier]. */
interface Alerts {
    /** A new question, or one whose agent flipped; a flip back to working is [silent]. */
    fun decision(decision: Decision, silent: Boolean = false)
    /** A snoozed question whose time came (#571): it notifies again, once. */
    fun back(decision: Decision) = decision(decision)
    fun cancel(id: String)
    fun prompt(prompt: Prompt)
    fun cancelPrompt(prompt: Prompt)
    /** A browser or phone signed in to the account asks to join. */
    fun join(id: String, name: String)
    /** A run's newest update: shows, updates or ends its notification. */
    fun run(run: Run)
    /** A run dismissed (#827): its notification goes. */
    fun cancelRun(id: String) {}
    /** Quota alerts the uploader newly raised; each shows once, if this phone opted in. */
    fun quota(notices: List<QuotaNotice>) {}
    /**
     * Signed out, or holding machines' items (#362): every notification goes, since they show
     * decrypted questions and commands and let the owner answer.
     */
    fun clearAll() {}
    /**
     * Signed out, deleted or removed: [clearAll], and what the account left on this phone beyond
     * its keys, its quota settings and the quota alerts already shown (#2035).
     */
    fun forget() = clearAll()
    /** An answer the server refused; the notification and its buttons come back. */
    fun failed(decision: Decision, why: String) {}
}

/** How long pull to refresh on Quotas waits for the machines' fresh snapshots. */
private const val QUOTA_ASK_SECONDS = 25

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
    /** Whether Android counts the default network as validated: a sync waits for it (#920). */
    private val network: StateFlow<Boolean> = MutableStateFlow(true),
    /** Asks for [flushAnswers] once a network is up; the app schedules [AnswerWorker]. */
    private val wakeWhenOnline: () -> Unit = {},
) : Store {
    private val lock = Mutex()
    private val loaded = disk.load()
    private var saved = loaded.first?.readable() ?: Saved(defaultServer)
    private var secrets = loaded.second
    private var directory: Directory? = null
    private var pending: Pair<PairingCode, PairingRequestBody>? = null

    /** The check key of the machine QR that [pending] came from, if any (#795). */
    private var pendingCheckKey: String? = null
    private var joinJob: Job? = null
    private var showJob: Job? = null
    private var pollJob: Job? = null

    /** A push reached this app since it started: the server can deliver, so nothing polls (#445). */
    @Volatile private var pushed = false

    /** How long [onPush] keeps the push service's thread: FCM allows about 20 seconds. */
    internal var pushWaitMs = 15_000L

    /** How often the app in front reads the items while no push has arrived. */
    internal var pollMs = 10_000L

    override val phase = MutableStateFlow<Phase>(Phase.SignedOut)
    override val joinLink = MutableStateFlow<String?>(null)
    override val decisions: StateFlow<List<Decision>> get() = decisionKind.shown
    override val unsent = MutableStateFlow(0)
    override val prompts: StateFlow<List<Prompt>> get() = promptKind.shown
    override val windows: StateFlow<List<QuotaWindow>> get() = quotaKind.windows
    override val quotaFailures: StateFlow<List<QuotaFailure>> get() = quotaKind.failures
    override val quotasHeld: StateFlow<Boolean> get() = quotaKind.held
    override val runs: StateFlow<List<Run>> get() = runKind.shown
    override val members = MutableStateFlow<List<Member>>(emptyList())
    override val approval = MutableStateFlow<Approval>(Approval.Idle)
    override val joinAsks: StateFlow<List<JoinAsk>> get() = joinKind.asks
    override val comparison: StateFlow<Comparison> get() = joinKind.comparison
    override val push = MutableStateFlow(PushSetting(saved.pushType, fcmAvailable, emptyList(), false))
    override val server = MutableStateFlow(saved.server)
    override val keepsKeys = MutableStateFlow(false)
    override val demo = MutableStateFlow(false)
    /** The server that said it is a demo: [demo] holds only while it is the saved one. */
    @Volatile private var demoServer: String? = null
    /** The server last asked, so each is asked once, however the phone reached Add this phone. */
    @Volatile private var demoAsked: String? = null
    override val busy = MutableStateFlow(false)
    override val tooOld = MutableStateFlow<String?>(null)
    private val reach = Reach(scope)
    override val connection = MutableStateFlow<String?>(null)
    /** A sync that waits for the network, then retries until the server answers (#920). */
    private var catchUpJob: Job? = null
    override val pushHold = MutableStateFlow<Int?>(null)
    /**
     * Counts wipes, so a hold read or saved for the account before one never lands after it (#1192).
     * Checked under `lock`, which every wipe holds.
     */
    @Volatile private var wipes = 0
    @Volatile private var inFront = false
    private var presenceJob: Job? = null
    private val beacon = Beacon({ present -> if (phase.value == Phase.Ready) api().presence(present) })
    /** The beacon's one lock: touches and checks come from different threads. */
    private val beaconLock = Mutex()

    override val notice = MutableStateFlow(
        // The files themselves are kept aside under their own names (Disk); the owner needs only what to do.
        "This phone's saved sign-in couldn't be read, so you're signed out. Sign in again.".takeIf { disk.unreadable.isNotEmpty() },
    )
    private val headBook = Heads(directories)
    override val heldRevoked = MutableStateFlow<HeldRevoked?>(null)
    /** The hold notice last shown, so it goes once the hold ends. */
    @Volatile private var shownHold: String? = null
    /**
     * Why this phone keeps its keys on a chain that drops it: a machine's head shows the chain cut
     * short (#1779). The chain is not kept; the next directory read decides again.
     */
    @Volatile private var removalHold: String? = null
    override val recovery = MutableStateFlow<RecoveryUi?>(null)
    override val replacing = MutableStateFlow<Replacing>(Replacing.Idle)
    /** While a new recovery key is on screen: its key pair, and the current one. */
    private var replacement: Pair<KeyPair, KeyPair>? = null
    /** What the item kinds use of this store; see [Core]. */
    private val core = object : Core {
        override val saved get() = this@ServerStore.saved
        override fun persist(newSaved: Saved) = this@ServerStore.persist(newSaved)
        override fun api() = this@ServerStore.api()
        override val phase get() = this@ServerStore.phase
        override val notice get() = this@ServerStore.notice
        override val alerts get() = this@ServerStore.alerts
        override val envelopes get() = this@ServerStore.envelopes
        override val scope get() = this@ServerStore.scope
        override val lock get() = this@ServerStore.lock
        override val directory get() = this@ServerStore.directory
        override val me get() = this@ServerStore.me
        override val signKey get() = this@ServerStore.signKey
        override fun now() = this@ServerStore.now()
        override fun newId(prefix: String) = this@ServerStore.newId(prefix)
        override fun describe(e: Exception) = this@ServerStore.describe(e)
        override fun report(e: Exception, sync: Boolean) = this@ServerStore.report(e, sync = sync)
        override fun withheld() = this@ServerStore.withheld()
        override fun open(item: SealedItem) = this@ServerStore.open(item)
        override suspend fun scan(items: List<SealedItem>) = this@ServerStore.scan(items)
        override suspend fun catchUp(item: SealedItem) = this@ServerStore.catchUp(item)
        override suspend fun syncDirectory() = this@ServerStore.syncDirectory()
        override suspend fun pushed(kind: String, id: String, push: JsonObject, re: Boolean, wakeAt: Boolean): Pair<SealedItem, String?> {
            val box = push["box"]?.jsonPrimitive?.content
            if (box == null) return api().item(id).let { it.item to it.answeredAt }
            val from = push.getValue("from").jsonPrimitive.content
            return SealedItem(1, kind, id, from, if (re) push["re"]?.jsonPrimitive?.content else null, listOf(SealedBox(me.id, box)), if (wakeAt) push["wakeAt"]?.jsonPrimitive?.content else null) to null
        }
        override suspend fun addMember(joining: DirectoryMember, taken: String) = this@ServerStore.addMember(joining, taken)
        override fun run(showBusy: Boolean, sync: Boolean, block: suspend () -> Unit) = this@ServerStore.run(showBusy, sync, block)
        override suspend fun locked(showBusy: Boolean, block: suspend () -> Unit) = this@ServerStore.locked(showBusy, block = block)
    }

    private val decisionKind = DecisionKind(core, disk, Images(sodium), wakeWhenOnline)
    private val promptKind = PromptKind(core, decisionKind::settle)
    private val quotaKind = QuotaKind(core)
    private val joinKind = JoinKind(core, joins)
    private val runKind = RunKind(core)

    /** Every kind of item, in the order a sync reads them. */
    private val kinds: List<ItemKind> = listOf(decisionKind, promptKind, quotaKind, runKind, joinKind)

    init {
        ImageFiles.read = disk::image
        // Written before anything else, so the next launch reads the small file.
        decisionKind.moveImagesToFiles(loaded.first != null && disk.unreadable.isEmpty()) { saved = it }
        directory = runCatching { verified(saved.entries) }.getOrNull()
        publish()
        if (saved.joining != null) waitForApproval()
        if (saved.digitJoin != null) waitForDigitJoin()
        scope.launch { network.collect(reach::network) }
        scope.launch { reach.status.collect { connection.value = Reach.words(it, host()) } }
    }

    // --- State ------------------------------------------------------------------

    private fun api() = Api(http, saved.server, secrets.session, reach)

    /** The server as the owner knows it: starbridge.run rather than https://starbridge.run. */
    private fun host() = runCatching { java.net.URI(saved.server).host }.getOrNull() ?: saved.server

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
        // From the outbox itself: a hold or a revoked machine empties the shown list, not it.
        unsent.value = saved.outbox.size
        keepsKeys.value = saved.me != null && saved.pin != null
        demo.value = demoServer != null && demoServer == saved.server
        phase.value = when {
            secrets.session == null -> Phase.SignedOut
            saved.joining != null -> Phase.Joining(saved.joining!!, saved.joiningScanned)
            saved.digitJoin != null -> Phase.JoiningByDigits(saved.digitJoin!!.digits, saved.digitJoin!!.matched)
            // Before the pin: the first entry waits on the server until the key is confirmed (#370).
            // A seed of another length came from before the first release, which showed words: nothing to show now.
            secrets.recoverySeed?.let(::fromB64)?.takeIf { it.size == 16 } != null ->
                Phase.RecoveryKey(RecoveryKeys.encode(fromB64(secrets.recoverySeed!!), sodium))
            saved.me == null || saved.pin == null -> Phase.NoDevice(saved.accountExists)
            else -> Phase.Ready
        }
        // An offered pairing link belongs to the setup it arrived in: a join, a recovery or a
        // sign-out ends it, so it never resurfaces in another account's or server's setup.
        if ((phase.value as? Phase.NoDevice)?.accountExists != true) joinLink.value = null
        // Add this phone asks its server once whether it is a demo: after a sign-in, at launch, or
        // back from a cancelled join (#2089).
        else if (demoAsked != saved.server) checkDemo()
        server.value = saved.server
        push.value = push.value.copy(type = saved.pushType, registered = saved.push?.type == saved.pushType)
        // While the server holds back entries a machine has seen, no machine's item shows (#362).
        val held = withheld() != null
        // A hold that ended takes its notice with it; only a confirmed one raises it.
        if (!held && notice.value != null && notice.value == shownHold) notice.value = null
        if (!held) heldRevoked.value = null
        members.value = directory?.let(::toUi).orEmpty()
        recovery.value = directory?.let(::recoveryUi)
        // A revoked machine's items leave, as on the web: nothing it asked can be answered (#344).
        val view = View(held, directory)
        for (kind in kinds) kind.publish(view)
    }

    fun setDistributors(list: List<String>) {
        push.value = push.value.copy(distributors = list)
    }

    /** Runs [block] off the caller, one at a time, and turns failures into a notice. */
    private fun run(showBusy: Boolean = true, sync: Boolean = false, block: suspend () -> Unit) {
        scope.launch { locked(showBusy, sync, block) }
    }

    // A run the owner sees raises busy before it waits for the lock: a pull during a quiet sync
    // shows at once. Quiet runs, such as the prompt poll, leave it alone.
    private suspend fun locked(showBusy: Boolean = true, sync: Boolean = false, block: suspend () -> Unit) = shown(showBusy) {
        lock.withLock {
            try {
                block()
            } catch (e: Exception) {
                report(e, sync = sync, asked = showBusy)
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

    /**
     * Turns a failure into a notice. A [sync] that only found the server unanswered leaves none: it
     * catches up once the server answers, and [connection] speaks if that takes long, at once if
     * the owner [asked] by a pull (#920). What the owner did themselves still says it failed.
     */
    private fun report(e: Exception, sync: Boolean = false, asked: Boolean = false) {
        // With the exception in the message: Android drops the trace of an UnknownHostException.
        Log.w("Starbridge", "failed: $e", e)
        if (sync && Reach.transient(e)) {
            if (asked) reach.surface()
            catchUp()
            return
        }
        if (e is ApiException && e.status == 401 && secrets.session != null) {
            // The keys stay: signing in again binds a new session to this phone.
            persist(newSecrets = secrets.copy(session = null))
            notice.value = "Your session ended. Sign in again; this phone keeps its keys."
            return
        }
        notice.value = describe(e)
    }

    private fun describe(e: Exception): String {
        if (e is TooOld) tooOld.value = e.minimum ?: "a newer release"
        return explain(e)
    }

    private fun explain(e: Exception): String = when (e) {
        is ApiException -> when (e.error) {
            "machine-cap" -> "This account already has its maximum number of machines; phones and browsers don't count. Revoke one first."
            "already-answered" -> "Already answered on another device."
            "rate-limited" -> "Too many tries. Wait a minute."
            "taken" -> "Another of your devices is already comparing digits for it."
            "closed" -> "That request was already answered or cancelled."
            else -> e.message ?: e.error
        }
        // Another account's key, or this account's from before a replacement (#348).
        is ProtocolException if e.code == "wrong-recovery-key" -> "This is a recovery key, but not this account's current one."
        is ProtocolException -> "Refused: the server sent something that does not check out (${e.code})."
        is IOException -> "Can't reach ${host()}."
        else -> e.message ?: e.toString()
    }

    private fun wipe(message: String?) {
        // Another account or server may have no push: poll again until one arrives.
        pushed = false
        // The next device this phone becomes has told the server nothing yet (#943).
        reportedNotify = null
        notifyStates.value = emptyMap()
        deviceClients.value = emptyMap()
        machineReleases.value = emptyMap()
        // The next account's hold shows once its own read succeeds, as on the web (#1192).
        pushHold.value = null
        removalHold = null
        wipes++
        joinJob?.cancel()
        showJob?.cancel()
        for (kind in kinds) kind.wipe()
        val wiped = disk.wipe()
        alerts.forget()
        pendingPush = null
        confirmedPush = null
        saved = Saved(saved.server, pushType = saved.pushType)
        secrets = Secrets()
        directory = null
        pending = null
        pendingCheckKey = null
        approval.value = Approval.Idle
        publish()
        notice.value = if (wiped) message else "Signed out, but this phone couldn’t delete everything it kept. Clearing the app’s data removes the rest."
    }

    // --- Signing in and setting up ------------------------------------------------

    /** The address as typed, with https:// when it names none, as a browser reads it. */
    private fun normalize(server: String) = server.trim().trimEnd('/').ifEmpty { defaultServer }.let { if ("://" in it) it else "https://$it" }

    override fun gitHubSignInUrl(server: String): String {
        val verifier = SignIn.newVerifier()
        persist(saved.copy(server = normalize(server)), secrets.copy(signInVerifier = verifier))
        return SignIn.url(saved.server, verifier)
    }

    override fun appleSignInUrl(): String {
        val verifier = SignIn.newVerifier()
        persist(saved.copy(server = defaultServer), secrets.copy(signInVerifier = verifier))
        return SignIn.url(saved.server, verifier, "apple")
    }

    /**
     * Only for the sign-in this phone started: without its verifier the code is worthless, and a
     * redirect with no sign-in pending is ignored. The code works once, whatever the outcome.
     */
    override fun receiveSignIn(redirect: String) = run {
        if (phase.value != Phase.SignedOut) return@run
        val verifier = secrets.signInVerifier ?: return@run
        // The state is the challenge this sign-in sent: a link from another sign-in is not this
        // phone's, and leaves the pending one alone.
        val challenge = SignIn.challenge(verifier)
        val link = when (val r = SignIn.redirect(redirect)) {
            is SignIn.Redirect.Code -> r.takeIf { it.state == challenge } ?: return@run
            is SignIn.Redirect.Denied -> if (r.state == challenge) throw IllegalStateException("Sign-in didn't finish. Sign in again.") else return@run
            null -> return@run
        }
        // This phone's own sign-in: a new try, which ends the last failure on the sign-in screen.
        notice.value = null
        persist(newSecrets = secrets.copy(signInVerifier = null))
        val session = try {
            Api(http, saved.server, null).appSession(link.code, verifier)
        } catch (e: ApiException) {
            throw IllegalStateException(if (e.error == "bad-code") "Sign-in expired. Sign in again." else describe(e))
        }
        afterSignIn(session)
    }

    override fun signInWithOwnerToken(server: String, token: String) = run {
        notice.value = null
        val address = normalize(server)
        if (address.toHttpUrlOrNull() == null) throw IllegalStateException("That server address isn't valid.")
        persist(saved.copy(server = address))
        val session = try {
            Api(http, saved.server, null).ownerSignIn(token.trim())
        } catch (e: Exception) {
            throw IllegalStateException(ownerTokenRefusal(e) ?: throw e)
        }
        afterSignIn(session)
    }

    /**
     * Why the server took no owner token, in the owner's words, or null when [explain] already
     * says it: a Play tester saw "unauthenticated: wrong owner token" go by and no more (2026-10-19).
     */
    private fun ownerTokenRefusal(e: Exception): String? = when {
        e is ApiException && e.status == 401 -> "Wrong owner token."
        e is ApiException && e.error == "not-configured" -> "${host()} doesn't take an owner token."
        // A 4xx without Starbridge's JSON, or a reply that holds no session: another website.
        e is ApiException && e.status in 400..499 && e.error.startsWith("http-") -> "No Starbridge server at ${host()}."
        e is NullPointerException || e is IllegalArgumentException || e is NoSuchElementException -> "No Starbridge server at ${host()}."
        e is SocketTimeoutException -> "${host()} didn't answer in time."
        else -> null
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
                val all = saved.entries + fresh.directory(saved.entries.size)
                val dir = directories.verify(all, saved.account, saved.pin)
                if (dir.members[mine.id]?.active == true) throw IllegalStateException("This server cannot bind a new session to this phone. Update the server.")
                // A chain the server cut short can drop this phone too: a machine's head shows it (#1779).
                headBook.withheldBy(saved.heads, dir, all)?.let { throw IllegalStateException(removalText(dir, it)) }
                wipe("This phone was removed from your devices. Set it up again.")
            }
        } else if (saved.pendingGenesis != null && me.account == saved.account) {
            // A first-device setup the server may already hold: keep its keys and seed to retry.
            persist(newSecrets = secrets.copy(session = session))
            return
        } else if (mine != null && saved.pin != null && me.account != saved.account) {
            // The server's word alone, unsigned: a hostile one could unpair the phone with it.
            // The owner signs in to the right account, or signs out to start over (#808).
            throw IllegalStateException("This phone belongs to another account than the one you signed in to. Sign in with the account you set it up with, or sign out and remove its keys to set it up again.")
        } else if (mine != null || secrets.signSk != null) {
            // A setup that never finished: start over.
            wipe(null)
        }
        if (me.member != null) throw IllegalStateException("This session already belongs to another device.")
        val exists = fresh.directory(0).isNotEmpty()
        persist(newSecrets = Secrets(session = session))
        persist(saved.copy(account = me.account, accountExists = exists, me = null, pin = null, entries = emptyList(), heads = emptyMap()))
    }

    /**
     * Asks the server whether it is a demo, for the hint on Add this phone. Only a hint: a failed
     * ask leaves it off, and it never shows for another server.
     */
    private fun checkDemo() {
        val server = saved.server
        demoAsked = server
        scope.launch {
            val answer = try {
                Api(http, server, null).demo()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("Starbridge", "demo check failed: $e")
                false
            }
            if (answer) demoServer = server else if (demoServer == server) demoServer = null
            demo.value = demoServer != null && demoServer == saved.server
        }
    }

    private fun newMember(): DirectoryMember {
        val boxKeys = sodium.boxKeyPair()
        val signKeys = sodium.signKeyPair()
        val member = DirectoryMember(newId("d_"), "device", deviceName.takeCodePoints(100).ifBlank { "Android" }, toB64(boxKeys.public), toB64(signKeys.public))
        // The keys reach the disk before the server hears of them, so a crash cannot strand them.
        // New keys end any recovery attempt that made the ones they replace.
        persist(saved.copy(recovering = null), secrets.copy(boxPk = member.boxPk, boxSk = toB64(boxKeys.secret), signPk = member.signPk, signSk = toB64(signKeys.secret)))
        return member
    }

    /**
     * Makes the keys, the seed and the signed first entry, all on disk, and shows the recovery key.
     * The server sees the entry only once the owner confirms the key, as on the web (#370):
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

    override fun offerJoinLink(link: String?) {
        joinLink.value = link?.takeIf { (phase.value as? Phase.NoDevice)?.accountExists == true }
    }

    override fun joinWithCode(text: String) = run {
        val code = try {
            codeFromLink(text)
        } catch (e: ProtocolException) {
            throw IllegalArgumentException("That QR code is not a Starbridge pairing code.")
        }
        try {
            join(code, scanned = true)
        } catch (e: ApiException) {
            // Most often the QR code of a phone or browser that is itself waiting to join (#1117).
            throw if (e.error == "taken") IllegalStateException("That QR code is another device asking to join. On a device you already use, open Add a device and show a QR code for this phone.") else e
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

    override fun recover(key: String) = run {
        val recovery = sodium.signSeedKeyPair(recoverySignSeed(RecoveryKeys.seed(key, sodium), sodium))
        val entries = api().directory(0)
        // The chain's current recovery key must be this one, whose own signature a server cannot
        // fake; a phone that was a device before keeps the server from serving it a shorter chain.
        val dir = directories.verify(entries, saved.account, saved.pin, recoveryPk = toB64(recovery.public))
        // The keys made for an earlier attempt stay until the chain holds them: when its reply was
        // lost, the server has bound the session to that member, and a retry finds it there (#274).
        // Only while those keys are still this phone's, and the chain either lacks the member or a
        // `recover` entry added it: a server could serve a fork where a device it holds added the
        // same member, leaving the other members in (#1132).
        val earlier = saved.recovering?.takeIf { r ->
            r.signPk == secrets.signPk && r.boxPk == secrets.boxPk &&
                dir.members[r.id].let { it == null || (it.active && recovered(r, entries)) }
        }
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

    /** Whether a `recover` entry of [entries], which only the recovery key signs, added [member]. */
    private fun recovered(member: DirectoryMember, entries: List<JsonElement>) = entries.any { raw ->
        runCatching {
            val env = ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw)
            ProtocolJson.decodeFromString(DirectoryEntry.serializer(), env.body).let { it.op == "recover" && it.member == member }
        }.getOrDefault(false)
    }

    // --- Syncing -----------------------------------------------------------------

    override fun refresh(shown: Boolean) {
        // A phone just unlocked may not have its network, or its VPN, back yet: wait for it (#920).
        if (!network.value) {
            if (shown) reach.surface()
            catchUp()
            return
        }
        run(showBusy = shown, sync = true) { sync() }
    }

    /**
     * Syncs once the network is validated, and again after 1 s, 2 s and so on up to 30 s while
     * the server does not answer. Only while the app is in front: coming back starts a sync anyway.
     */
    private fun catchUp() {
        if (catchUpJob?.isActive == true) return
        catchUpJob = scope.launch {
            var wait = 1_000L
            while (true) {
                network.first { it }
                if (!inFront || phase.value != Phase.Ready) return@launch
                val done = lock.withLock {
                    try {
                        sync()
                        true
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (!Reach.transient(e)) report(e)
                        !Reach.transient(e)
                    }
                }
                if (done) return@launch
                delay(wait)
                wait = (wait * 2).coerceAtMost(30_000)
            }
        }
    }

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

    /** The Quotas widget's own read, with the app closed: what the server holds, with no ask and no busy. False when it could not read them. */
    suspend fun syncQuotasQuietly(): Boolean {
        // Signed out: nothing to read, and nothing to retry.
        var done = phase.value != Phase.Ready
        locked(showBusy = false) {
            if (phase.value != Phase.Ready) return@locked
            // The directory first, as a full sync: a machine added since could not sign its snapshots otherwise.
            syncDirectory()
            if (phase.value != Phase.Ready) return@locked
            quotaKind.sync()
            done = true
        }
        return done
    }

    private suspend fun sync() {
        if (phase.value != Phase.Ready) return
        syncDirectory()
        if (phase.value != Phase.Ready) return
        for (kind in kinds) kind.sync()
        // The server answered, so a push route that failed to register gets another try.
        pendingPush?.let { runCatching { subscribeHeld(it) } }
    }

    /** Fetches what is new and replays the whole chain; it must extend the pin. */
    private suspend fun syncDirectory() {
        val fresh = api().directory(saved.entries.size)
        // Nothing new: the chain verified at start, or when it last grew, still holds (#1469).
        // A removal on hold is decided again at each read: its heads may have gone since (#1779).
        if (fresh.isEmpty() && removalHold == null && directory?.members?.get(me.id)?.active == true) return
        val all = saved.entries + fresh
        val dir = directories.verify(all, saved.account, saved.pin)
        if (dir.members[me.id]?.active != true) {
            // A chain the server cut short can drop this phone too: a machine's head shows it, and
            // the phone holds as it does for items, keeping its chain and keys (#1779).
            val held = headBook.withheldBy(saved.heads, dir, all)
            if (held != null) {
                val why = removalText(dir, held)
                removalHold = why
                heldRevoked.value = held.revoked?.let { HeldRevoked(held.id, why) }
                notice.value = why
                shownHold = why
                alerts.clearAll()
                // The lists empty now, as an item hold's persist empties them.
                publish()
                return
            }
            directory = dir
            wipe("This phone was removed from your devices.")
            return
        }
        removalHold = null
        directory = dir
        closeRevoked(dir)
        persist(saved.copy(entries = all, pin = Pin(dir.length, dir.head)))
    }

    /** Closes the notifications of revoked machines' questions and prompts: no answer reaches them. */
    private fun closeRevoked(dir: Directory) {
        for (kind in kinds) kind.revoked(dir)
    }

    /**
     * Opens a machine's item and keeps the directory head it signed. Refuses every item while a
     * head an active machine signed is missing from this phone's chain (#362).
     */
    private fun open(item: SealedItem): Item? = try {
        // Null once a directory read found this phone removed (wipe).
        val dir = directory ?: throw ProtocolException("no-directory", "")
        val opened = envelopes.open(item, me.id, box, dir)
        // Machines' heads only: a device's snooze vouches for nothing here (#571).
        if (SIGNER_ROLE[item.kind] == "machine") keepHead(item.from, (opened.body as? ItemBody)?.dir)
        if (withheld() != null) null else Item(item.from, opened.body, opened.bodyText)
    } catch (e: ProtocolException) {
        // Not shown: an item that fails its checks is the server's or a stranger's.
        Log.w("Starbridge", "dropped ${item.kind} ${item.id}: ${e.message}")
        null
    }

    private fun keepHead(machine: String, head: DirectoryHead?) {
        val heads = saved.heads.toMutableMap()
        if (headBook.note(heads, machine, head, saved.entries)) persist(saved.copy(heads = heads))
    }

    /**
     * Why no machine's item counts: the server holds back entries a machine has seen. It names the
     * machine. A head whose member a `revoke` names says who revoked it: only the owner can tell
     * whether they did, or a revoked device forged it on a fork (#813).
     */
    private fun withheld(): String? {
        removalHold?.let { return it }
        val dir = directory ?: return null
        val held = headBook.withheldBy(saved.heads, dir, saved.entries) ?: return null
        fun name(id: String) = dir.members[id]?.member?.name ?: id
        val machine = name(held.id)
        val seen = "The server is holding back changes to your devices that $machine has seen."
        val revoked = held.revoked
            ?: return "$seen Nothing from your machines shows until it sends them. If this does not clear, revoke $machine."
        return "$seen ${name(revoked.by)} revoked ${name(revoked.id)} on ${revoked.at.take(10)}. If you did not, the server may be hiding that ${name(revoked.by)} was revoked. Nothing from your machines shows until this clears; if you did, tap Stop waiting."
    }

    /** Why this phone keeps its keys on chain [dir], which drops it while [held] shows it cut short (#1779). */
    private fun removalText(dir: Directory, held: Withheld): String {
        fun name(id: String) = dir.members[id]?.member?.name ?: id
        val machine = name(held.id)
        val why = "The server's list of your devices says this phone was removed, but $machine has seen changes to it that the server is holding back. This phone keeps its keys until the server sends them."
        val revoked = held.revoked ?: return why
        return "$why ${name(revoked.by)} revoked $machine on ${revoked.at.take(10)}: if you did, tap Stop waiting."
    }

    override fun stopWaiting(memberId: String) = run {
        forgetHeads(memberId)
        heldRevoked.value = null
        sync()
    }

    private fun forgetHeads(memberId: String) {
        val heads = saved.heads.toMutableMap()
        if (headBook.forget(heads, memberId)) persist(saved.copy(heads = heads))
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
        // A removal on hold set its own (#1779).
        if (removalHold == null) heldRevoked.value = directory?.let { headBook.withheldBy(saved.heads, it, saved.entries) }?.revoked?.let { HeldRevoked(it.id, why) }
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

    override fun refreshDirectory() = run(showBusy = false, sync = true) {
        if (phase.value == Phase.Ready) syncDirectory()
    }

    override fun refreshPrompts() = promptKind.refresh()

    override fun answerPrompt(id: String, allow: Boolean, scope: String, message: String?) = promptKind.answer(id, allow, scope, message)

    /**
     * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
     * asked. A deny is for this call only; a wider allow only for a scope the prompt offered.
     */
    suspend fun sendPrompt(id: String, allow: Boolean, scope: String, message: String?) = promptKind.send(id, allow, scope, message)

    /** For the notification's buttons: holds the lock like any other change. */
    suspend fun sendPromptFromNotification(id: String, allow: Boolean, scope: String) = promptKind.sendFromNotification(id, allow, scope)

    override fun loadImages(id: String) = decisionKind.loadImages(id)

    override fun answer(id: String, choice: String?, text: String?) = decisionKind.answer(id, choice, text)

    override fun snooze(id: String, until: Instant) = decisionKind.snooze(id, until)

    /** Answers decision [id]; the notification's buttons call this too. */
    suspend fun send(id: String, choice: String?, text: String?): Sent = decisionKind.send(id, choice, text)

    /** For the notification's buttons, under the lock. */
    suspend fun sendFromNotification(id: String, choice: String?, text: String?): Sent = decisionKind.sendFromNotification(id, choice, text)

    /** The server refused this phone's answer to [id]: its card and its notification come back, saying [why]. */
    fun refused(id: String, why: String) = decisionKind.refused(id, why)

    /** The answer waiting to be sent for decision [id], if any. */
    fun queued(id: String): String? = decisionKind.queued(id)

    /** Sends the queued answers; false while some still wait, so [AnswerWorker] tries again later. */
    suspend fun flushAnswers(): Boolean = decisionKind.flushAnswers()

    override fun dismissRun(id: String) = runKind.dismiss(id)

    // --- Push --------------------------------------------------------------------

    /**
     * A push payload (PROTOCOL.md, "Push"): a new item with this device's box when it fits, else
     * its id to fetch; or `answered` once a decision is answered anywhere.
     */
    suspend fun onPush(payload: String): Unit {
        // Before the lock: a push that times out waiting for a poll still counts.
        pushed = true
        // On the app's scope, so a push that waits past the push service's budget for the lock,
        // held by a sync retrying on a slow network, is still handled once the lock frees: with
        // `pushed` set, no poll would read its item (#1497).
        val job = scope.launch {
            try {
                onPushHeld(payload)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Nothing may escape this coroutine: it would end the app (#253).
                Log.w("Starbridge", "push failed", e)
                // Its item may be unread, and with `pushed` set no poll reads it (#1978).
                catchUp()
            }
        }
        withTimeoutOrNull(pushWaitMs) { job.join() }
    }

    private suspend fun onPushHeld(payload: String) = lock.withLock {
        if (phase.value != Phase.Ready) return@withLock
        val p = ProtocolJson.parseToJsonElement(payload).jsonObject
        val kind = p["kind"]?.jsonPrimitive?.content ?: return@withLock
        val id = p["id"]?.jsonPrimitive?.content ?: return@withLock
        // An id goes into /items/$id, a kind picks the item kind that takes it: neither may carry anything else.
        if (!isItemId(id) || !isPushKind(kind)) return@withLock
        if (kind != "answered") {
            kinds.find { kind in it.pushes }?.onPush(kind, id, p)
            return@withLock
        }
        // Nothing in this push is verified, so it only takes the notification down, and keeps
        // a late push of the item from ringing (#2151); what was answered is read from the
        // server's signed items on the next sync.
        persist(saved.notifying(id, NotifyEvent.Closed).first)
        if (!promptKind.cancelNotification(id)) alerts.cancel(id)
        if (inFront) {
            try {
                sync()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Unreachable now: the foreground poll, which a working push stops, reads it later.
                pushed = false
                throw e
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

    /** The endpoint the server took since the app started. */
    @Volatile private var confirmedPush: String? = null

    private suspend fun subscribeHeld(route: PushRoute) {
        if (phase.value != Phase.Ready || route.type != saved.pushType) return
        val old = saved.push
        val same = old != null && old.type == route.type && old.endpoint == route.endpoint
        if (same && confirmedPush == route.endpoint) {
            pendingPush = null
            return
        }
        pendingPush = route
        // The same endpoint registers again once per start, since the server drops a subscription
        // its push service once called gone (#1011); subscribing again keeps its id.
        if (old != null && !same) {
            runCatching { api().unsubscribe(old.id) }
            // Forgotten first, so a failed replacement is not mistaken for a working route.
            persist(saved.copy(push = null))
        }
        val id = api().subscribe(route.type, route.endpoint, route.keys)
        persist(saved.copy(push = SavedPush(route.type, id, route.endpoint)))
        confirmedPush = route.endpoint
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
            val other = if (e is ApiException && e.status == 404) otherServer(code, saved.server) else null
            approval.value = Approval.Failed(
                when {
                    other != null -> "This code is from $other, and this phone is signed in to ${runCatching { URI(saved.server).rawAuthority }.getOrNull() ?: saved.server}."
                    e is ApiException && e.status == 404 -> "No pairing with this code, or it expired."
                    else -> describe(e)
                },
            )
            return@run
        }
        val body = try {
            pairings.openRequest(request, parsed)
        } catch (e: ProtocolException) {
            approval.value = Approval.Failed("This request does not match the code. Don't approve it; make a new code.")
            return@run
        }
        pending = parsed to body
        pendingCheckKey = checkKeyFromLink(code).takeIf { body.role == "machine" }
        approval.value = Approval.Found(body.name, if (body.role == "machine") Kind.Machine else Kind.Device, parsed.formatted())
    }

    /** Appends the new member's entry, then sends the approval that lets it check the chain. */
    override fun approvePairing() = run(showBusy = false) {
        val (code, body) = pending ?: return@run
        approval.value = Approval.Approving(approval.value as? Approval.Found ?: return@run)
        try {
            syncDirectory()
            // A retry after the approval failed to send finds the entry already in the chain.
            addMember(body.member(), "Another member already uses this id. Make a new code.")
            val after = directory!!
            // From the machine's QR: proves which add entry this phone wrote, so the machine needs
            // no one to compare check codes (#795).
            val check = pendingCheckKey?.let { pairings.checkProof(saved.entries, body.id, it) }
            api().approve(code.rendezvous, pairings.approval(PairingApprovalBody(1, code.rendezvous, saved.account!!, after.length, after.head, me.id, check), code))
            // That machine asks nothing, so its check code answers no question here (#1329).
            if (check != null) persist(saved.copy(scannedMachines = (saved.scannedMachines + body.id).distinct()))
            pending = null
            pendingCheckKey = null
            val compare = if (body.role == "machine" && check == null) runCatching { pairings.checkCode(saved.entries, body.id) }.getOrNull() else null
            approval.value = Approval.Done(body.name, compare)
        } catch (e: Exception) {
            approval.value = Approval.Failed(describe(e))
        }
    }

    override fun closePairing() {
        showJob?.cancel()
        pending = null
        pendingCheckKey = null
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
                    pendingCheckKey = null
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

    /**
     * While the app is in front and no push has reached it, reads the items every [pollMs]: a
     * server without a relay or UnifiedPush sends none, and the Inbox would never change (#445).
     * Quiet: a failed read leaves no notice, since the next one, or the owner's pull, says why.
     */
    override fun foreground(on: Boolean) {
        inFront = on
        // Time spent behind, offline or not, counts for nothing toward saying so (#920).
        if (on) reach.resumed()
        presenceJob?.cancel()
        // In front, it checks whether it still counts; sent behind, it says absent once.
        presenceJob = scope.launch {
            while (true) {
                beaconLock.withLock { beacon.tick(inFront) }
                if (!inFront) break
                delay(Beacon.CHECK_MS)
            }
        }
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

    override fun touched() {
        scope.launch { beaconLock.withLock { if (beacon.input(inFront)) beacon.tick(inFront) } }
    }

    override fun loadPushHold() {
        val wiped = wipes
        scope.launch {
            // A server without the setting shows no row.
            runCatching { api().pushHold() }.onSuccess { lock.withLock { if (wipes == wiped) pushHold.value = it } }
        }
    }

    override val notifyStates = MutableStateFlow<Map<String, String>>(emptyMap())
    override val deviceClients = MutableStateFlow<Map<String, String>>(emptyMap())
    override val machineReleases = MutableStateFlow<Map<String, MachineRelease>>(emptyMap())
    /** The state the server holds for this phone, once it took one. */
    private var reportedNotify: Boolean? = null

    override fun loadNotifyStates() {
        scope.launch {
            // A server without the route: Devices shows no states.
            runCatching { api().notifications() }.onSuccess { (states, clients) ->
                notifyStates.value = states
                deviceClients.value = clients
            }
            // A server without the route: no machine shows an update.
            runCatching { api().machineReleases() }.onSuccess { machineReleases.value = it }
        }
    }

    override fun reportNotifications(on: Boolean) {
        scope.launch {
            if (phase.value != Phase.Ready || reportedNotify == on) return@launch
            runCatching { api().setNotifications(if (on) "on" else "off") }.onSuccess { reportedNotify = on }
        }
    }

    override fun setPushHold(seconds: Int) {
        val was = pushHold.value
        val wiped = wipes
        pushHold.value = seconds
        scope.launch {
            val saved = runCatching { api().setPushHold(seconds) }
            lock.withLock {
                if (wipes != wiped) return@launch
                saved.onSuccess { pushHold.value = it }.onFailure { pushHold.value = was }
            }
            (saved.exceptionOrNull() as? Exception)?.let { report(it) }
        }
    }

    override fun watchJoins(on: Boolean) = joinKind.watch(on)

    override fun compareJoin(id: String) = joinKind.compare(id)

    override fun approveJoin() = joinKind.approve()

    override fun refuseJoin(id: String) = joinKind.refuse(id)

    override fun closeComparison() = joinKind.closeComparison()

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
        // This phone signed the revocation, so it is no fork: a head the member forged ends with it (#813).
        forgetHeads(memberId)
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
        val shown = RecoveryKeys.encode(seed, sodium)
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

    /** Appends [joining]'s add entry unless the chain holds it already; [taken] says why one with its id differs. */
    private suspend fun addMember(joining: DirectoryMember, taken: String) {
        val present = directory!!.members[joining.id]
        if (present == null) appendEntry { directories.addEntry(it, me.id, signKey, joining, now()) }
        else if (!present.active || present.member != joining) throw IllegalStateException(taken)
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
        // Answers still in the outbox go first: the wipe below drops them (#2155).
        if (phase.value == Phase.Ready && saved.outbox.isNotEmpty()) decisionKind.flushBeforeSignOut()
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

    /** A failed delete is reported and forgets nothing, so the owner can try again. */
    override fun deleteAccount() = run {
        api().deleteAccount()
        wipe(null)
    }

    fun say(message: String) {
        notice.value = message
    }

    override fun dismissNotice() {
        notice.value = null
    }

    // --- To the screens' shapes --------------------------------------------------

    private fun toUi(dir: Directory): List<Member> {
        val added = saved.entries.mapNotNull { raw ->
            runCatching {
                val env = ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw)
                val body = ProtocolJson.decodeFromString(DirectoryEntry.serializer(), env.body)
                body.member?.id?.let { it to body.at }
            }.getOrNull()
        }.toMap()
        return dir.members.values.filter { it.active }.map { (m) ->
            val machine = m.role == "machine"
            Member(
                m.id, m.name, if (machine) Kind.Machine else Kind.Device, instant(added[m.id]) ?: Instant.EPOCH,
                current = m.id == saved.me?.id,
                check = if (machine && m.id !in saved.scannedMachines) runCatching { pairings.checkCode(saved.entries, m.id) }.getOrNull() else null,
            )
        }
    }
}

private operator fun dev.starbridge.app.protocol.DirectoryMember.component1() = member

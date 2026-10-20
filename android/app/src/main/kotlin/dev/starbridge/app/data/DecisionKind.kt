package dev.starbridge.app.data

import dev.starbridge.app.protocol.Images
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.Settled
import dev.starbridge.app.protocol.Snooze
import dev.starbridge.app.protocol.Waiting
import dev.starbridge.app.protocol.DecisionLink
import dev.starbridge.app.protocol.fromB64
import dev.starbridge.app.protocol.ANSWER_TEXT_MAX
import dev.starbridge.app.protocol.takeCodePoints
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.IOException
import java.time.Instant

/** An answer this phone has yet to hand the server, and when it was given; null for one queued before #895. */
private data class Tap(val answer: String, val at: Instant?)

/** What became of an answer: sent, waiting for a connection, answered elsewhere, or refused. */
sealed interface Sent {
    /** The server took this device's answer, now or before: a second tap lands here (#331). */
    data class Answered(val answer: String) : Sent
    /**
     * Kept on the phone until the server takes it; [AnswerWorker] sends it (#329). [offline] when
     * the request never got an answer, rather than a 429 or 5xx (#1390).
     */
    data class Queued(val answer: String, val offline: Boolean = false) : Sent
    data object Elsewhere : Sent
    data class Failed(val why: String) : Sent
}

/**
 * Decisions: the questions machines ask, with the waiting, snooze and settled items about them,
 * and this phone's answers, kept in [Saved.outbox] until the server takes them (#329).
 */
internal class DecisionKind(
    private val core: Core,
    private val disk: Disk,
    private val images: Images,
    /** Asks for [flushAnswers] once a network is up; the app schedules [AnswerWorker]. */
    private val wakeWhenOnline: () -> Unit,
) : ItemKind {
    override val pushes = setOf("decision", "waiting", "snooze")

    /** The decisions as the Inbox shows them, this phone's unsent answers laid over. */
    val shown = MutableStateFlow<List<Decision>>(emptyList())

    private val saved get() = core.saved
    private val alerts get() = core.alerts
    private val notice get() = core.notice
    private val directory get() = core.directory
    private val me get() = core.me
    private val signKey get() = core.signKey
    private val envelopes get() = core.envelopes
    private val phase get() = core.phase
    private val lock get() = core.lock
    private val scope get() = core.scope
    private fun persist(newSaved: Saved) = core.persist(newSaved)
    private fun api() = core.api()
    private fun open(item: SealedItem) = core.open(item)
    private suspend fun scan(items: List<SealedItem>) = core.scan(items)
    private suspend fun syncDirectory() = core.syncDirectory()
    private fun withheld() = core.withheld()
    private fun describe(e: Exception) = core.describe(e)
    private fun now() = core.now()
    private fun newId(prefix: String) = core.newId(prefix)
    private fun run(showBusy: Boolean = true, block: suspend () -> Unit) = core.run(showBusy, block = block)
    private suspend fun locked(showBusy: Boolean = true, block: suspend () -> Unit) = core.locked(showBusy, block)

    /** Answers tapped but not yet sealed into [Saved.outbox]: the lock may be busy. */
    private val tapped = java.util.concurrent.ConcurrentHashMap<String, Tap>()
    /** Why the server refused this phone's last answer to a question, by decision id: its card says so. */
    private val notSent = java.util.concurrent.ConcurrentHashMap<String, String>()
    /** The decisions as saved, before this phone's unsent answers are laid over them ([showUnsent]). */
    @Volatile private var savedDecisions: List<Decision> = emptyList()

    /**
     * The next sync reads which questions the server holds open, and drops the open ones kept here
     * that it no longer lists, as the web does: once a run, and after an answer found its question
     * gone (#1980).
     */
    @Volatile private var checkOpen = true

    override fun publish(view: View) {
        savedDecisions = if (view.held) emptyList() else saved.decisions.filter { view.active(it.from) }.map(::toUi)
        showUnsent()
    }

    override fun revoked(dir: dev.starbridge.app.protocol.Directory) {
        for (d in saved.decisions) if (dir.members[d.from]?.active == false) alerts.cancel(d.body.id)
    }

    /**
     * Lays this phone's unsent answers over the decisions: a question leaves the open list the
     * moment it is answered, and comes back with [Decision.notSent] if the server refuses it (#895).
     */
    @Synchronized
    private fun showUnsent() {
        val unsent = saved.outbox.associate { it.decisionId to Tap(it.answer, instant(it.at)) } + tapped
        shown.value = savedDecisions.map { d ->
            val tap = unsent[d.id]
            when {
                !d.isOpen -> d
                tap != null -> d.copy(answer = tap.answer, answeredAt = tap.at ?: d.createdAt, sending = true)
                else -> notSent[d.id]?.let { d.copy(notSent = it) } ?: d
            }
        }
    }

    override suspend fun sync() {
        // Before the reads: one failing, during a rate-limit hold say, must not keep an answer back (#1390).
        if (saved.outbox.isNotEmpty()) flushHeld()
        // Read first: a question posted after this read is not kept here yet, so none is dropped.
        val listedOpen = if (checkOpen) openDecisions() else null
        val kept = saved.decisions.map { it.body.id }.toSet()
        var cursor = saved.cursor
        val byId = saved.decisions.associateBy { it.body.id }.toMutableMap()
        // How each item a settled notice closed was closed, with the time: the notice lists before
        // the decision it closed, which moved past it.
        val closings = mutableMapOf<String, Pair<Settled, String>>()
        // Which device's answer each machine took, whenever its notice comes (#330).
        val wins = mutableListOf<Pair<String, Settled>>()
        val waits = mutableListOf<Pair<String, Waiting>>()
        val snoozes = mutableListOf<Snooze>()
        while (true) {
            // An answered question's images download when its sheet shows them (#1382).
            val page = api().items("decision,settled,waiting,snooze", cursor, openBlobs = true)
            // Held: the cursor stays, so these items are read again once the hold ends.
            if (scan(page.items.map { it.item })) return
            for (listed in page.items) {
                if (listed.item.kind == "waiting") {
                    val (from, body) = open(listed.item) ?: continue
                    waits += from to body as Waiting
                    continue
                }
                if (listed.item.kind == "snooze") {
                    val (_, body) = open(listed.item) ?: continue
                    snoozes += body as Snooze
                    continue
                }
                if (listed.item.kind == "settled") {
                    val (from, body) = open(listed.item) ?: continue
                    body as Settled
                    if (body.outcome == "device") wins += from to body
                    // Keyed by machine: a notice closes only the machine's own items (#362).
                    else closings["$from/${body.itemId}"] = body to listed.receivedAt
                    continue
                }
                // The notice that closed it arrived in the same write, so it carries the same time;
                // a later one, after a device's answer, closed nothing.
                fun settledBy(machine: String) = closings["$machine/${listed.item.id}"]?.takeIf { it.second == listed.answeredAt }?.first
                val known = byId[listed.item.id]
                if (known != null) {
                    // A settled push marked it answered already, without saying how.
                    val notice = settledBy(known.from)
                    if (listed.answeredAt != null && (known.answeredAt == null || notice?.outcome != null)) {
                        byId[known.body.id] = if (notice?.outcome != null) closedBy(known.copy(answeredAt = listed.answeredAt), notice)
                        else known.copy(answeredAt = listed.answeredAt)
                        alerts.cancel(known.body.id)
                    }
                    continue
                }
                val (from, _, text) = open(listed.item) ?: continue
                val decision = SavedDecision(from, text, listed.answeredAt)
                byId[listed.item.id] = saved(listed.item, settledBy(from)?.let { closedBy(decision, it) } ?: decision)
            }
            cursor = page.cursor
            if (page.last) break
        }
        // An update may list before the decision it is about, so they apply once all are read.
        for ((from, w) in waits) byId[w.decisionId]?.let { d -> wait(d, from, w)?.let { byId[w.decisionId] = it } }
        for (z in snoozes) byId[z.decisionId]?.let { d ->
            snoozed(d, z)?.let {
                byId[z.decisionId] = it
                if (isSnoozed(it)) alerts.cancel(z.decisionId)
            }
        }
        for ((from, n) in wins) byId[n.itemId]?.let { d -> won(d, from, n)?.let { byId[n.itemId] = it } }
        // Still open here after this read, but no longer on the server: dropped, as by retention.
        if (listedOpen != null) {
            val sending = saved.outbox.map { it.decisionId }.toSet()
            val gone = byId.values.filter { d ->
                val id = d.body.id
                id in kept && id !in listedOpen && id !in sending && d.answeredAt == null && d.answer == null && d.settled == null
            }.map { it.body.id }
            for (id in gone) {
                byId.remove(id)
                alerts.cancel(id)
            }
        }
        persist(saved.copy(cursor = cursor, decisions = byId.values.sortedBy { it.body.createdAt }.takeLast(500)))
        if (listedOpen != null) checkOpen = false
    }

    /** The ids of the decisions the server holds open for this device. */
    private suspend fun openDecisions(): Set<String> {
        val ids = mutableSetOf<String>()
        var at = ""
        while (true) {
            val page = api().items("decision", at, openBlobs = true, open = true)
            page.items.forEach { ids += it.item.id }
            at = page.cursor
            if (page.last) return ids
        }
    }

    /**
     * [d] with the agent's waiting state from [w], or null when [w] changes nothing: it must come
     * from the machine that asked, and only a later update replaces an earlier one.
     */
    /**
     * [d] with its images opened from [item]'s blobs, once, as it is kept (#685). Listed answered
     * without them, it keeps none until its sheet shows it ([loadImages]).
     */
    private fun saved(item: SealedItem, d: SavedDecision): SavedDecision =
        if (d.body.images.isNullOrEmpty() || item.blobs == null) d else filed(d, images.openAll(d.body.images.orEmpty(), item.blobs))

    /** [d] with [opened] (base64url, null for one that did not open) each in its own file (#1471). */
    private fun filed(d: SavedDecision, opened: List<String?>): SavedDecision =
        d.copy(images = emptyList(), imageFiles = opened.mapIndexed { i, b64 -> b64?.let { disk.putImage("${d.body.id}.$i", fromB64(it)) } })

    /**
     * Moves the images an older app kept inside `state.bin` into files of their own, once (#1471).
     * A question whose files cannot be written keeps its images where they were. A file's name is
     * its question's id and the image's place, so a question an older app rewrote without
     * [SavedDecision.imageFiles] finds its files again, and only a question no longer kept, such
     * as one past the 500, loses its files. Nothing goes while a state file could not be read: the
     * one set aside may name them.
     */
    fun moveImagesToFiles(stateRead: Boolean, adopt: (Saved) -> Unit) {
        val moved = saved.decisions.map { d ->
            when {
                d.images.isNotEmpty() -> runCatching { filed(d, d.images) }.getOrElse { d }
                d.imagesPending -> {
                    val found = d.body.images.orEmpty().indices.map { i -> "${d.body.id}.$i".takeIf { disk.hasImage(it) } }
                    // Only a whole set: one cut short by a failed write still fetches the rest.
                    if (found.all { it != null }) d.copy(imageFiles = found) else d
                }
                else -> d
            }
        }
        if (moved != saved.decisions) {
            val next = saved.copy(decisions = moved)
            if (runCatching { disk.save(next) }.isSuccess) adopt(next)
        }
        if (stateRead) {
            val kept = saved.decisions.map { it.body.id }.toSet()
            runCatching { disk.pruneImages { name -> name.substringBeforeLast('.') in kept } }
        }
    }

    /** Questions whose images this run fetched or is fetching (#1382). */
    private val imagesAsked = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /**
     * Fetches the images of a question listed without them (#1382), each checked against the hash
     * its signed body holds, and keeps them. Once per question while the app runs, unless the fetch
     * fails: one whose images fail to open stays without them.
     */
    fun loadImages(id: String) {
        if (saved.decisions.find { it.body.id == id }?.imagesPending != true || !imagesAsked.add(id)) return
        scope.launch {
            val listed = try {
                api().item(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Offline or refused: the next show asks again.
                imagesAsked.remove(id)
                return@launch
            }
            // After any sync under way, which writes back the list it read; a failed write is
            // reported, as every locked run's is.
            locked(showBusy = false) {
                val d = saved.decisions.find { it.body.id == id }?.takeIf { it.imagesPending } ?: return@locked
                // The same question from the same machine: each blob opens against the key and
                // hash in the body this phone kept, never one the server sends now.
                val (from, _) = open(listed.item) ?: return@locked
                if (listed.item.kind != "decision" || listed.item.id != id || from != d.from) return@locked
                val opened = images.openAll(d.body.images.orEmpty(), listed.item.blobs)
                if (opened.all { it == null }) return@locked
                persist(saved.copy(decisions = saved.decisions.map { if (it === d) filed(d, opened) else it }))
            }
        }
    }

    /** Fetches decision [id] and keeps it; null when it does not open. */
    private suspend fun fetchDecision(id: String): SavedDecision? {
        val listed = api().item(id)
        if (directory?.members?.containsKey(listed.item.from) != true) syncDirectory()
        val (from, _, text) = open(listed.item) ?: return null
        val d = saved(listed.item, SavedDecision(from, text, listed.answeredAt))
        persist(saved.copy(decisions = saved.decisions + d))
        return d
    }

    /** [d] with the owner's snooze [z], or null when the one kept wins over it (#2103). */
    private fun snoozed(d: SavedDecision, z: Snooze): SavedDecision? {
        if (!laterSnooze(d.snoozedAt, d.snoozedUntil, z.at, z.until)) return null
        return d.copy(snoozedUntil = z.until, snoozedAt = z.at)
    }

    /** Whether the owner put [d] off and its time has not come. */
    private fun isSnoozed(d: SavedDecision, now: Instant = Instant.now()) =
        d.answeredAt == null && d.answer == null && snoozedUntil(d)?.isAfter(now) == true

    /** Until when [d] is snoozed; none after back now, whose time is its own (#571). */
    private fun snoozedUntil(d: SavedDecision): Instant? {
        val until = instant(d.snoozedUntil) ?: return null
        val at = instant(d.snoozedAt)
        return until.takeIf { at == null || it.isAfter(at) }
    }

    private fun wait(d: SavedDecision, from: String, w: Waiting): SavedDecision? {
        if (d.from != from) return null
        if (!laterWaiting(d.waitingAt, d.waiting, w.at, w.state)) return null
        return d.copy(waiting = w.state, waitingAt = w.at)
    }

    /** A settled notice may close one of the machine's decisions: it counts as answered. */
    /** A notice after a device's answer closed nothing, so only an open decision takes its [outcome]. */
    fun settle(id: String, from: String, notice: Settled) {
        val d = saved.decisions.find { it.body.id == id && it.from == from } ?: return
        alerts.cancel(id)
        val updated = if (notice.outcome == "device") won(d, from, notice)
        else if (d.answeredAt == null && d.answer == null) closedBy(d.copy(answeredAt = now()), notice)
        else null
        if (updated != null) persist(saved.copy(decisions = saved.decisions.map { if (it === d) updated else it }))
    }

    /** [d] as its machine's [notice] closed it, with the agent's reason for a withdrawal (#1008). */
    private fun closedBy(d: SavedDecision, notice: Settled) =
        d.copy(settled = notice.outcome, reason = notice.reason?.takeIf { notice.outcome == "withdrawn" })

    /** Decisions this phone's answer lost to another device's, until the machine says which won. */
    private val lost = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /**
     * [d] answered with the other device's answer the asking machine's notice names, or null when
     * the notice is not the asking machine's, names this phone, or carries no answer (#330).
     */
    private fun won(d: SavedDecision, from: String, n: Settled): SavedDecision? {
        // A device's notice with neither choice nor text applied a Done (#539).
        val answer = n.choice ?: n.text ?: d.body.answerIn?.let(::doneText) ?: return null
        if (d.from != from || n.device == null || n.device == me.id || d.answer != null) return null
        if (lost.remove(d.body.id)) notice.value = if ((n.choice ?: n.text) == null) markedBy(n.device) else answeredFirst(answer, n.device)
        return d.copy(answeredAt = d.answeredAt ?: now(), theirAnswer = answer, answeredBy = n.device)
    }

    private fun answeredFirst(answer: String, device: String) = "Answered on ${deviceName(device)}: $answer"

    /** This phone's answer lost to another device's Done (#539). */
    private fun markedBy(device: String) = "Marked answered on ${deviceName(device)}."

    private fun deviceName(device: String) = directory?.members?.get(device)?.member?.name ?: device

    /**
     * One answer per decision: the decision stays locked until the server takes it, which may
     * wait for a connection (#329).
     */
    fun answer(id: String, choice: String?, text: String?) {
        if (saved.outbox.any { it.decisionId == id }) return
        val page = saved.decisions.find { it.body.id == id }?.body?.answerIn
        if (tapped.putIfAbsent(id, Tap(choice ?: text ?: page?.let(::doneText).orEmpty(), Instant.now())) != null) return
        notSent.remove(id)
        showUnsent()
        run(showBusy = false) {
            try {
                when (val sent = send(id, choice, text)) {
                    is Sent.Queued -> {
                        val what = if (choice == null && text == null) "Done" else sent.answer
                        notice.value = if (sent.offline) "No connection. $what will be sent when the phone is back online." else "$what isn't sent yet. Retrying."
                    }
                    Sent.Elsewhere -> {
                        val d = saved.decisions.find { it.body.id == id }
                        val by = d?.answeredBy
                        val theirs = d?.theirAnswer
                        if (by != null && theirs != null) notice.value = if (d?.body?.answerIn?.let { theirs == doneText(it) } == true) markedBy(by) else answeredFirst(theirs, by)
                        else {
                            lost += id
                            notice.value = "Already answered on another device."
                        }
                    }
                    is Sent.Failed -> notSent[id] = sent.why
                    is Sent.Answered -> Unit
                }
            } catch (e: Exception) {
                // The session ended: report() asks to sign in again, and the answer waits for it.
                if (e is CancellationException || e is ApiException && e.status == 401) throw e
                notSent[id] = describe(e)
            } finally {
                tapped.remove(id)
                showUnsent()
            }
        }
    }

    fun snooze(id: String, until: Instant) {
        run(showBusy = false) {
            withheld()?.let { notice.value = "Not snoozed: $it"; return@run }
            val d = saved.decisions.find { it.body.id == id } ?: return@run
            // Fresh, as the server checks the recipients against its own: a device removed
            // elsewhere since the last read would make it refuse the snooze.
            syncDirectory()
            val dir = directory ?: return@run
            val machine = dir.members[d.from]?.takeIf { it.active }?.member
            if (machine == null) {
                notice.value = "Not snoozed: the machine that asked is no longer in your directory."
                return@run
            }
            // To the machine that asked, so its agent hears when it would block, and to every
            // active device, this one included, so each one hides it.
            val to = listOf(machine) + dir.members.values.filter { it.active && it.member.role == "device" }.map { it.member }
            // The latest `at`, in whole seconds, wins everywhere: an Undo within the second of its
            // snooze goes a second later, or the machine and the other devices keep the snooze (#1981).
            val last = saved.decisions.find { it.body.id == id }?.snoozedAt
            val at = snoozeStamp(Instant.parse(now()), last)
            // Back now, as Undo is, goes no later than its own `at`, which every client reads as
            // back now (PROTOCOL.md, "Snoozing"): the tap's instant is ahead of the clock the
            // inbox keeps, so the question stayed under Snoozed until that clock next ticked. Nor
            // later than now: the server pushes a return at a future `until` (#1981).
            val sent = Instant.now().let { now -> if (until.isAfter(now)) until else minOf(now, Instant.parse(at)) }
            val body = buildJsonObject {
                put("v", 1)
                put("id", newId("z_"))
                put("decisionId", id)
                putJsonArray("to") { to.forEach { add(it.id) } }
                put("until", sent.toString())
                put("at", at)
                putJsonObject("dir") { put("length", dir.length); put("head", dir.head) }
            }
            try {
                api().postItem(envelopes.seal("snooze", body, me.id, signKey, to))
            } catch (e: ApiException) {
                // The session ended: report() asks to sign in again.
                if (e.status == 401) throw e
                notice.value = if (e.error == "already-answered") "Already answered on another device." else "Not snoozed: ${describe(e)}"
                return@run
            } catch (e: IOException) {
                notice.value = "No connection. Not snoozed."
                return@run
            }
            persist(saved.copy(decisions = saved.decisions.map { if (it.body.id == id) it.copy(snoozedUntil = sent.toString(), snoozedAt = at) else it }))
            if (until.isAfter(Instant.now())) alerts.cancel(id)
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
        // Neither choice nor text is Done (#539), for a decision answered on its own page that takes it.
        val page = d.body.answerIn?.takeIf { d.body.done == true }
        val done = choice == null && text == null
        if (done && page == null) throw IllegalArgumentException("Done is only for a question answered on its own page.")
        val machine = directory?.members?.get(d.from)?.takeIf { it.active }?.member
            ?: throw IllegalStateException("The machine that asked is no longer in your directory.")
        val answerId = newId("a_")
        val at = now()
        val body = buildJsonObject {
            put("v", 1)
            put("id", answerId)
            put("decisionId", id)
            put("to", machine.id)
            put("answeredAt", at)
            choice?.let { put("choice", it) }
            text?.let { put("text", it) }
            if (done) put("done", true)
            // Lets the machine notice a server holding back entries, such as a revocation.
            directory?.let { d -> putJsonObject("dir") { put("length", d.length); put("head", d.head) } }
        }
        val queued = QueuedAnswer(id, choice ?: text ?: doneText(page!!), envelopes.seal("answer", body, me.id, signKey, listOf(machine)), at = at)
        // Scheduled before the answer is saved, and so before its request leaves: were the app
        // killed at any point after the save, the saved answer still has a sender (#1979, #2091).
        // The run waits for the lock this holds, then finds it sent, or finds nothing if the save
        // failed.
        wakeWhenOnline()
        persist(saved.copy(outbox = saved.outbox + queued))
        return post(queued, wake = false)
    }

    /**
     * Posts a queued answer and settles it, or keeps it for [wakeWhenOnline] to send later. [wake]
     * is false in [AnswerWorker]'s own run, which retries by its backoff instead.
     */
    private suspend fun post(q: QueuedAnswer, wake: Boolean = true): Sent {
        try {
            api().postItem(q.item)
        } catch (e: CancellationException) {
            // Cut off mid-request, by the notification's time limit say: it may have landed.
            keep(q, landed = true, wake)
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
                    keep(q, landed = false, wake)
                    throw e
                }
                // This release is refused: the answer waits for the updated app to send it.
                e is TooOld -> {
                    describe(e)
                    keep(q, landed = false, wake)
                    Sent.Queued(q.answer)
                }
                e.status >= 500 || e.status == 429 -> {
                    keep(q, landed = e.status != 502 && e.status != 503 && e.status != 429, wake)
                    Sent.Queued(q.answer)
                }
                else -> {
                    persist(saved.copy(outbox = saved.outbox.filter { it.decisionId != q.decisionId }))
                    // Its question may be gone from the server: the next sync checks (#1980).
                    if (e.status == 404) checkOpen = true
                    Sent.Failed(describe(e))
                }
            }
        } catch (e: IOException) {
            // No route or no name: the request never left. Anything else may have reached it.
            keep(q, landed = e !is java.net.ConnectException && e !is java.net.UnknownHostException && e !is java.net.NoRouteToHostException, wake)
            return Sent.Queued(q.answer, offline = true)
        }
        settle(q, q.answer)
        return Sent.Answered(q.answer)
    }

    private fun keep(q: QueuedAnswer, landed: Boolean, wake: Boolean) {
        if (landed && !q.mayHaveLanded) {
            persist(saved.copy(outbox = saved.outbox.map { if (it.decisionId == q.decisionId) it.copy(mayHaveLanded = true) else it }))
        }
        if (wake) wakeWhenOnline()
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

    /**
     * For the notification's buttons. The notification goes at the tap, as the card does, and
     * comes back only if the server refuses the answer; one left queued goes out with
     * [AnswerWorker] (#1447). A reply typed into a notification is cut as the in-app field cuts
     * it (#1205).
     */
    suspend fun sendFromNotification(id: String, choice: String?, text: String?): Sent {
        alerts.cancel(id)
        val sent = lock.withLock { send(id, choice, text?.takeCodePoints(ANSWER_TEXT_MAX)) }
        if (sent is Sent.Failed) refused(id, sent.why)
        return sent
    }

    /** The server refused this phone's answer to [id]: its card and its notification come back, saying [why]. */
    fun refused(id: String, why: String) {
        notSent[id] = why
        showUnsent()
        shown.value.find { it.id == id }?.let { alerts.failed(it, why) }
    }

    /** The answer waiting to be sent for decision [id], if any. */
    fun queued(id: String): String? = saved.outbox.find { it.decisionId == id }?.answer

    /**
     * Sends the queued answers, oldest first, and tells the notifications how each ended. False
     * while some still wait, so [AnswerWorker] tries again later. It first waits out a rate-limit
     * hold, outside the lock: posting during it would fail at once and only lengthen the worker's
     * backoff (#1390).
     */
    suspend fun flushAnswers(): Boolean {
        while (true) {
            val held = limitedUntil - System.currentTimeMillis()
            if (held > 0) {
                delay(held)
                continue
            }
            lock.lock()
            try {
                // A post under the lock meanwhile, such as the tap's own that scheduled this run
                // (#1979), may have started a hold: wait it out too, without the lock.
                if (limitedUntil > System.currentTimeMillis()) continue
                return flushQueued()
            } finally {
                lock.unlock()
            }
        }
    }

    private suspend fun flushQueued(): Boolean {
        if (phase.value != Phase.Ready) return true
        return try {
            flushHeld(wake = false) && saved.outbox.isEmpty()
        } catch (e: IOException) {
            // The answers wait in the outbox, and their cards say "not sent yet".
            core.report(e, sync = true)
            false
        }
    }

    private suspend fun flushHeld(wake: Boolean = true): Boolean {
        // Kept, and tried again once the hold ends.
        if (withheld() != null) return false
        for (q in saved.outbox) {
            val decision = shown.value.find { it.id == q.decisionId }
            when (val sent = post(q, wake)) {
                is Sent.Queued -> return false
                is Sent.Answered, Sent.Elsewhere -> alerts.cancel(q.decisionId)
                is Sent.Failed -> refused(q.decisionId, sent.why)
            }
        }
        return true
    }

    override suspend fun onPush(kind: String, id: String, push: JsonObject) {
        when (kind) {
            "decision" -> {
                // Kept already, or closed by a push that came first (#2151).
                if (saved.decisions.any { it.body.id == id } || saved.notified[id]?.closed == true) return
                // Fetched later than the push: another device may have answered meanwhile.
                val (item, answeredAt) = core.pushed("decision", id, push)
                // A machine paired since the last sync is not in the cached chain yet.
                core.catchUp(item)
                val (from, _, text) = open(item) ?: return
                val saved1 = saved(item, SavedDecision(from, text, answeredAt))
                persist(saved.copy(decisions = saved.decisions + saved1))
                if (answeredAt != null) return
                val (next, effect) = saved.notifying(id, NotifyEvent.Asked)
                persist(next)
                if (effect == NotifyEffect.Ring) alerts.decision(toUi(saved1))
            }
            "waiting" -> {
                // Pushed when the agent flips: to waiting re-notifies once, back to working moves
                // the notification silently (#191). A question asked already waiting pushes only
                // this, so its decision may be new here.
                val (item) = core.pushed("waiting", id, push)
                core.catchUp(item)
                val (from, body) = open(item) ?: return
                body as Waiting
                if (saved.notified[body.decisionId]?.closed == true) return
                val d = saved.decisions.find { it.body.id == body.decisionId } ?: fetchDecision(body.decisionId) ?: return
                val updated = wait(d, from, body) ?: return
                // To waiting rings, back to working moves the notification quietly; a flip that
                // comes before its question rings as the question (#2151).
                val (next, effect) = saved.copy(decisions = saved.decisions.map { if (it === d) updated else it })
                    .notifying(d.body.id, NotifyEvent.Flip(body.at, body.state))
                persist(next)
                if (effect != NotifyEffect.None && d.answeredAt == null && d.answer == null && saved.outbox.none { it.decisionId == d.body.id } && !isSnoozed(d)) {
                    alerts.decision(toUi(updated), silent = effect == NotifyEffect.Quiet)
                }
            }
            "snooze" -> {
                // The owner put a question off (#571): its notification goes until its time, when
                // the server pushes the snooze once more and the question notifies again, once.
                val (item) = core.pushed("snooze", id, push, wakeAt = true)
                core.catchUp(item)
                val (_, body) = open(item) ?: return
                body as Snooze
                val d = saved.decisions.find { it.body.id == body.decisionId } ?: fetchDecision(body.decisionId) ?: return
                // A newer snooze of the question, from any device, stands: an older one's return
                // shows nothing.
                val sent = instant(body.at) ?: return
                if (instant(d.snoozedAt)?.isAfter(sent) == true) return
                val updated = snoozed(d, body) ?: d
                if (updated !== d) persist(saved.copy(decisions = saved.decisions.map { if (it === d) updated else it }))
                val until = instant(body.until) ?: return
                if (!until.isAfter(instant(body.at) ?: until)) return // Back now: listed again, quietly.
                // The server says which push this is (#1290); without it, the clock, which takes a
                // first push that comes late for the return (#1320).
                val due = push["due"]?.jsonPrimitive?.booleanOrNull ?: !Instant.now().isBefore(until.minus(WAKE_SKEW))
                if (!due) {
                    // Near or past its time, its return showed the question or will, maybe by a
                    // server clock ahead of this one: cancelling would hide it.
                    if (Instant.now().isBefore(until.minus(WAKE_SKEW))) alerts.cancel(body.decisionId)
                } else if (updated.answeredAt == null && updated.answer == null) {
                    // Once per return: the same push delivered again rings nothing (#2151).
                    val (next, effect) = saved.notifying(body.decisionId, NotifyEvent.Return(body.at, due = true))
                    persist(next)
                    if (effect == NotifyEffect.Ring) alerts.back(toUi(updated))
                }
            }
        }
    }

    private fun toUi(d: SavedDecision): Decision {
        val b = d.body
        return Decision(
            id = b.id,
            question = b.question,
            context = b.context,
            options = b.options,
            recommended = b.recommended,
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
            snoozedUntil = snoozedUntil(d),
            // Pending, each holds its place at its shape until it downloads (#1382).
            images = when {
                d.imagesPending -> b.images.orEmpty().map { Image("", it.width, it.height, it.alt) }
                // Read from its file when it is decoded, off the main thread (#1471).
                d.imageFiles.isNotEmpty() -> b.images.orEmpty().mapIndexedNotNull { i, it -> d.imageFiles.getOrNull(i)?.let { f -> Image("", it.width, it.height, it.alt, file = f) } }
                else -> b.images.orEmpty().mapIndexedNotNull { i, it -> d.images.getOrNull(i)?.let { data -> Image(data, it.width, it.height, it.alt) } }
            },
            links = b.links.orEmpty().map { Link(it.url, it.title) },
            answerIn = b.answerIn?.let { Link(it.url, it.title) },
            answer = d.answer,
            answeredAt = instant(d.answeredAt) ?: d.answer?.let { Instant.now() },
            settled = d.settled,
            reason = d.reason,
            theirAnswer = d.theirAnswer,
            answeredOn = d.answeredBy?.let { directory?.members?.get(it)?.member?.name ?: it },
            replies = b.replies == true,
            takesDone = b.answerIn != null && b.done == true,
        )
    }
}

/** What a Done reads as, in History and on the device it lost on: where the owner answered. */
internal fun doneText(page: DecisionLink) = "Answered in ${Link(page.url, page.title).place()}"

/**
 * How far a snooze's time may be ahead of the phone's clock when its second push comes: the server
 * sends it at the time, a little late, by its own clock. A snooze runs at least 5 minutes
 * (SNOOZE_MIN in ui/inbox/Snooze.kt), so its first push passes for its second only when it comes
 * over 3 minutes late (#571). Servers since #1290 say which push is which; this is for older ones.
 */
private val WAKE_SKEW: java.time.Duration = java.time.Duration.ofMinutes(2)

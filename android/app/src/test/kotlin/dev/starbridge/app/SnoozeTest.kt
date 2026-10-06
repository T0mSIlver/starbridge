package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.SavedDecision
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.parseJsonText
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Snoozing (#571): another device's snooze hides a question and closes its notification; at its
 * time the server pushes it again and the question notifies once more, "back"; a snooze already
 * over says nothing; and this phone's snooze goes to the machine that asked and every device.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SnoozeTest {
    @get:Rule val tmp = TemporaryFolder()
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private val account = "acct"
    private val at = "2026-10-05T12:00:00Z"
    private val signKeys = sodium.signKeyPair()
    private val boxKeys = sodium.boxKeyPair()
    private val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
    private val webSign = sodium.signKeyPair()
    private val web = Member("web", "device", "Chrome", toB64(sodium.boxKeyPair().public), toB64(webSign.public))
    private val machineSign = sodium.signKeyPair()
    private val machine = Member("m_box", "machine", "devbox", toB64(sodium.boxKeyPair().public), toB64(machineSign.public))
    private val entries = mutableListOf<JsonElement>().apply {
        add(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        for (m in listOf(machine, web)) add(envelopeJson(directories.addEntry(directories.verify(this, account, null), "phone", signKeys.secret, m, at)))
    }
    private val dir = directories.verify(entries, account, null)
    private val decisionBody = buildJsonObject {
        put("v", 1)
        put("id", "d_1")
        putJsonArray("to") { add(JsonPrimitive("phone")); add(JsonPrimitive("web")) }
        put("createdAt", at)
        put("question", "Publish 0.1.1?")
        put("context", "")
        putJsonArray("options") { add(JsonPrimitive("Publish")); add(JsonPrimitive("Wait")) }
        put("recommended", "Publish")
        putJsonObject("source") { put("machine", "devbox"); put("project", "p"); put("session", "s") }
    }
    private val alerted = mutableListOf<String>()
    private val posted = mutableListOf<SealedItem>()

    private fun json(body: JsonElement) = MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    private fun store(): ServerStore {
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> {
                    val from = request.url.queryParameter("from")!!.toInt()
                    json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                }
                "/v1/items" -> {
                    posted += ProtocolJson.decodeFromJsonElement(SealedItem.serializer(), parseJsonText(request.body!!.utf8()))
                    json(buildJsonObject { put("cursor", "9") })
                }
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()
        val disk = Disk(tmp.newFolder(), object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        })
        val server = http.url("/").toString().trimEnd('/')
        disk.save(
            Saved(
                server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList(),
                decisions = listOf(SavedDecision(machine.id, decisionBody.toString(), waiting = "waiting", waitingAt = at)),
            ),
        )
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) { alerted += "decision ${decision.id}" }
            override fun back(decision: Decision) { alerted += "back ${decision.id}" }
            override fun cancel(id: String) { alerted += "cancel $id" }
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
    }

    /** The web device snoozes d_1 until [until], sent at [sent]; the push as the server sends it. */
    private fun push(id: String, until: Instant, sent: Instant): String {
        val item = envelopes.seal("snooze", buildJsonObject {
            put("v", 1)
            put("id", id)
            put("decisionId", "d_1")
            putJsonArray("to") { listOf(machine, phone, web).forEach { add(JsonPrimitive(it.id)) } }
            put("until", until.toString())
            put("at", sent.toString())
        }, web.id, webSign.secret, listOf(machine, phone, web))
        return buildJsonObject {
            put("v", 1)
            put("kind", "snooze")
            put("id", item.id)
            put("from", web.id)
            put("re", "d_1")
            put("wakeAt", item.wakeAt!!)
            put("box", item.boxes.single { it.to == "phone" }.box)
        }.toString()
    }

    private fun waitingPush(state: String): String {
        val item = envelopes.seal("waiting", buildJsonObject {
            put("v", 1)
            put("id", "w_1")
            put("decisionId", "d_1")
            putJsonArray("to") { add(JsonPrimitive("phone")); add(JsonPrimitive("web")) }
            put("at", Instant.now().toString())
            put("state", state)
        }, machine.id, machineSign.secret, listOf(phone, web))
        return buildJsonObject {
            put("v", 1); put("kind", "waiting"); put("id", item.id); put("from", machine.id); put("re", "d_1")
            put("box", item.boxes.single { it.to == "phone" }.box)
        }.toString()
    }

    @Test
    fun aSnoozeHidesTheQuestionAndMutesItsFlips() {
        val store = store()
        val now = Instant.now()
        runBlocking { store.onPush(push("z_1", now.plus(Duration.ofHours(3)), now)) }
        assertEquals(listOf("cancel d_1"), alerted)
        val shown = store.decisions.value.single()
        assertNotNull(shown.snoozedUntil)
        // While snoozed, the agent's flips ring nothing.
        runBlocking { store.onPush(waitingPush("working")) }
        runBlocking { store.onPush(waitingPush("waiting")) }
        assertEquals(listOf("cancel d_1"), alerted)
    }

    @Test
    fun atItsTimeItNotifiesOnceBack() {
        val store = store()
        val now = Instant.now()
        // The server pushes the snooze again at its time: it ends now, sent hours ago.
        runBlocking { store.onPush(push("z_1", now.plusSeconds(30), now.minus(Duration.ofHours(3)))) }
        assertEquals(listOf("back d_1"), alerted)
    }

    @Test
    fun anOlderSnoozesReturnShowsNothingOnceANewerOneIsKnown() {
        val store = store()
        val now = Instant.now()
        runBlocking { store.onPush(push("z_new", now.plus(Duration.ofHours(5)), now)) }
        runBlocking { store.onPush(push("z_old", now.plusSeconds(30), now.minus(Duration.ofHours(1)))) }
        assertEquals(listOf("cancel d_1"), alerted)
        assertNotNull(store.decisions.value.single().snoozedUntil)
    }

    @Test
    fun backNowFromAFastClockIsOver() {
        val store = store()
        val ahead = Instant.now().plus(Duration.ofMinutes(4))
        runBlocking { store.onPush(push("z_1", ahead, ahead)) }
        assertEquals(emptyList<String>(), alerted)
        assertEquals(null, store.decisions.value.single().snoozedUntil)
    }

    @Test
    fun backNowSaysNothing() {
        val store = store()
        val now = Instant.now()
        runBlocking { store.onPush(push("z_1", now, now)) }
        assertEquals(emptyList<String>(), alerted)
    }

    @Test
    fun aSnoozeFromThisPhoneGoesToTheMachineAndEveryDevice() {
        val store = store()
        val until = Instant.now().plus(Duration.ofHours(1)).truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        store.snooze("d_1", until)
        assertNotNull(http.takeRequest(5, TimeUnit.SECONDS))
        for (i in 0 until 50) if (posted.isEmpty()) Thread.sleep(100)
        val item = posted.single()
        assertEquals("snooze", item.kind)
        assertEquals("d_1", item.re)
        assertEquals(until.toString(), item.wakeAt)
        assertEquals(setOf("m_box", "phone", "web"), item.boxes.map { it.to }.toSet())
        for (i in 0 until 50) if (alerted.isEmpty()) Thread.sleep(100)
        assertEquals(listOf("cancel d_1"), alerted)
    }
}

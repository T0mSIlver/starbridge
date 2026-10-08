package dev.starbridge.app

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
import dev.starbridge.app.data.Sent
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Headers
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.UnknownHostException
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import dev.starbridge.app.protocol.Decision as DecisionBody

/**
 * An answer is never lost: offline it waits on the phone (#329), and a second tap sends nothing
 * more (#331). Its card goes at the tap, and a refused answer brings it back (#895).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AnswerQueueTest {
    @get:Rule val compose = createComposeRule()
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()
    private val posted = CopyOnWriteArrayList<String>()
    @Volatile private var offline = false
    /** Holds each POST until counted down, as a slow network would. */
    @Volatile private var gate = CountDownLatch(0)
    /** What the server replies to a POST. */
    @Volatile private var reply = { MockResponse(201, Headers.headersOf("content-type", "application/json"), "{}") }
    private var wakes = 0
    private val disk = Disk(Files.createTempDirectory("starbridge").toFile(), object : Vault {
        override fun wrap(plain: ByteArray) = plain
        override fun unwrap(wrapped: ByteArray) = wrapped
    })
    private val alerts = object : Alerts {
        override fun decision(decision: Decision, silent: Boolean) {}
        override fun cancel(id: String) {}
        override fun join(id: String, name: String) {}
        override fun prompt(prompt: Prompt) {}
        override fun cancelPrompt(prompt: Prompt) {}
        override fun run(run: Run) {}
    }

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    /** A phone and a machine in one directory, and one open question from the machine. */
    private fun setUp() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machine = Member("m_box", "machine", "devbox", toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)
        val decision = ProtocolJson.decodeFromJsonElement<DecisionBody>(buildJsonObject {
            put("v", 1)
            put("id", "d_ship")
            putJsonArray("to") { add(JsonPrimitive("phone")) }
            put("createdAt", at)
            put("question", "Ship the dark mode toggle today?")
            put("context", "")
            putJsonArray("options") { add(JsonPrimitive("Ship")); add(JsonPrimitive("Hold")) }
            put("recommended", "Ship")
            putJsonObject("source") { put("machine", "devbox"); put("project", "p"); put("session", "s") }
        })
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.method == "POST" && request.url.encodedPath == "/v1/items") {
                    gate.await()
                    posted += request.body!!.utf8()
                    reply()
                } else {
                    MockResponse(404, Headers.headersOf(), "")
                }
        }
        http.start()
        disk.save(
            Saved(
                http.url("/").toString().trimEnd('/'), account = account, accountExists = true, me = phone,
                pin = Pin(dir.length, dir.head), entries = entries.toList(), decisions = listOf(SavedDecision(machine.id, ProtocolJson.encodeToString(DecisionBody.serializer(), decision))),
            ),
        )
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
    }

    /** Offline as a phone without a network sees it: the server's name does not resolve. */
    private val client = OkHttpClient.Builder()
        .addInterceptor { chain -> if (offline) throw UnknownHostException("no network") else chain.proceed(chain.request()) }
        .build()

    private fun store() = ServerStore(disk, client, sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", "", false, scope) { wakes++ }

    @Test
    fun anAnswerTappedOfflineWaitsAndIsSentOnceWhenTheNetworkIsBack() {
        setUp()
        offline = true
        val store = store()
        store.answer("d_ship", "Hold", null)
        runBlocking { withTimeout(5_000) { while (disk.saved()!!.outbox.isEmpty() || wakes == 0) delay(10) } }
        // Still waiting, and shown answered but not sent, after the tap's attempt failed.
        runBlocking { delay(200) }
        store.decisions.value.single().let { assertEquals("Hold", it.answer); assertTrue(it.sending) }
        assertEquals(0, posted.size)

        // The app was closed meanwhile: the answer is on disk, and the worker sends it.
        offline = false
        val reopened = store()
        reopened.decisions.value.single().let { assertEquals("Hold", it.answer); assertTrue(it.sending) }
        assertTrue(runBlocking { reopened.flushAnswers() })
        assertTrue(runBlocking { reopened.flushAnswers() })
        assertEquals(1, posted.size)
        assertTrue(posted.single().contains("\"re\":\"d_ship\""))
        reopened.decisions.value.single().let { assertEquals("Hold", it.answer); assertFalse(it.sending) }
        assertTrue(disk.saved()!!.outbox.isEmpty())
    }

    @Test
    fun aDoubleTapOnANotificationAnswerSendsOnceAndReportsItSent() {
        setUp()
        val store = store()
        val sent = runBlocking {
            listOf(
                scope.async { store.sendFromNotification("d_ship", "Ship", null) },
                scope.async { store.sendFromNotification("d_ship", "Ship", null) },
            ).awaitAll()
        }
        assertEquals(listOf(Sent.Answered("Ship"), Sent.Answered("Ship")), sent)
        assertEquals(1, posted.size)
    }

    private val question = "Ship the dark mode toggle today?"

    /** The inbox as the app shows it, over [store]'s decisions. */
    private fun showInbox(store: ServerStore) = compose.setContent {
        val decisions by store.decisions.collectAsState()
        StarbridgeTheme { InboxScreen(decisions, Instant.parse("2026-10-06T12:01:00Z"), DecisionActions(store::answer, {})) }
    }

    @Test
    fun theCardGoesOnTheFrameAfterTheTapWhileTheServerHasYetToReply() {
        setUp()
        gate = CountDownLatch(1)
        val store = store()
        showInbox(store)
        compose.onNodeWithText(question).assertExists()

        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("Hold").performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText(question).assertDoesNotExist()
        assertEquals(0, posted.size)

        gate.countDown()
        runBlocking { withTimeout(5_000) { while (disk.saved()!!.outbox.isNotEmpty()) delay(10) } }
        store.decisions.value.single().let { assertEquals("Hold", it.answer); assertFalse(it.sending) }
    }

    @Test
    fun aRefusedAnswerBringsTheCardBackWithWhyAndAnsweringAgainSendsIt() {
        setUp()
        reply = { MockResponse(400, Headers.headersOf("content-type", "application/json"), """{"error":"bad-schema","message":"The answer does not match the question."}""") }
        val store = store()
        showInbox(store)
        compose.onNodeWithText("Hold").performClick()
        compose.waitUntil(5_000) { store.decisions.value.single().notSent != null }
        compose.onNodeWithText(question).assertExists()
        compose.onNodeWithText("Not sent: bad-schema", substring = true).assertExists()
        assertTrue(disk.saved()!!.outbox.isEmpty())

        reply = { MockResponse(201, Headers.headersOf("content-type", "application/json"), "{}") }
        compose.onNodeWithText("Hold").performClick()
        compose.waitUntil(5_000) { !store.decisions.value.single().sending && store.decisions.value.single().answer != null }
        compose.onNodeWithText(question).assertDoesNotExist()
        assertEquals(2, posted.size)
    }
}

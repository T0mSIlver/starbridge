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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.UnknownHostException
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import dev.starbridge.app.protocol.Decision as DecisionBody

/** An answer is never lost: offline it waits on the phone (#329), and a second tap sends nothing more (#331). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AnswerQueueTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()
    private val posted = CopyOnWriteArrayList<String>()
    @Volatile private var offline = false
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
                    posted += request.body!!.utf8()
                    MockResponse(201, Headers.headersOf("content-type", "application/json"), "{}")
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
        runBlocking { withTimeout(5_000) { while (disk.saved()!!.outbox.isEmpty() || store.sending.value.isEmpty()) delay(10) } }
        // Still waiting, and shown as waiting, after the tap's attempt failed.
        runBlocking { delay(200) }
        assertEquals(mapOf("d_ship" to "Hold"), store.sending.value)
        assertEquals(null, store.decisions.value.single().answeredAt)
        assertTrue(wakes > 0)
        assertEquals(0, posted.size)

        // The app was closed meanwhile: the answer is on disk, and the worker sends it.
        offline = false
        val reopened = store()
        assertEquals(mapOf("d_ship" to "Hold"), reopened.sending.value)
        assertTrue(runBlocking { reopened.flushAnswers() })
        assertTrue(runBlocking { reopened.flushAnswers() })
        assertEquals(1, posted.size)
        assertTrue(posted.single().contains("\"re\":\"d_ship\""))
        assertEquals("Hold", reopened.decisions.value.single().answer)
        assertEquals(emptyMap<String, String>(), reopened.sending.value)
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
}

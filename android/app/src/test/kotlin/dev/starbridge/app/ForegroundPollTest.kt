package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
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
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/**
 * With no push reaching the app, the app in front reads the items on its own, stops in the
 * background and once a push arrives, and a pull fetches what is new (#445).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ForegroundPollTest {
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

    private fun json(body: JsonElement) = MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    @Test
    fun theAppInFrontReadsTheItemsUntilAPushArrives() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machineSign = sodium.signKeyPair()
        val machine = Member("m_box", "machine", "box", toB64(sodium.boxKeyPair().public), toB64(machineSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)

        fun decision(id: String) = envelopes.seal("decision", buildJsonObject {
            put("v", 1); put("id", id); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Deploy?"); put("context", ""); putJsonArray("options") { add("Yes"); add("No") }; put("recommended", "Yes")
            putJsonObject("source") { put("machine", "box"); put("project", "p"); put("session", "s") }
        }, machine.id, machineSign.secret, listOf(phone))
        val listed = mutableListOf<SealedItem>()
        fun page() = buildJsonObject {
            put("items", buildJsonArray {
                synchronized(listed) {
                    listed.forEachIndexed { i, item -> add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(item)); put("cursor", "${i + 1}"); put("receivedAt", at) }) }
                }
            })
            put("cursor", "${synchronized(listed) { listed.size }}")
        }
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }
        val reads = AtomicInteger()

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                "/v1/items" -> if (request.url.queryParameter("kind")!!.startsWith("decision")) {
                    reads.incrementAndGet()
                    // Every item from the start: the store skips the ones it has.
                    json(page())
                } else json(empty)
                "/v1/quota" -> json(empty)
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()

        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        val disk = Disk(tmp.newFolder(), identity)
        val server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList()))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
        store.pollMs = 50

        // In front, with no push: a question posted later shows without a pull.
        store.foreground(true)
        synchronized(listed) { listed += decision("d_1") }
        until { store.decisions.value.map { it.id } == listOf("d_1") }

        // In the background, nothing reads.
        store.foreground(false)
        Thread.sleep(200)
        val stopped = reads.get()
        Thread.sleep(300)
        assertEquals(stopped, reads.get())

        // A pull fetches what is new.
        synchronized(listed) { listed += decision("d_2") }
        store.refresh()
        until { store.decisions.value.size == 2 }

        // Once a push reaches the app, the push brings the news and the poll stops.
        runBlocking { store.onPush("""{"kind":"answered","id":"d_none"}""") }
        store.foreground(true)
        Thread.sleep(200)
        val pushed = reads.get()
        Thread.sleep(300)
        assertEquals(pushed, reads.get())
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import dev.starbridge.app.protocol.KeyPair
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * Done on a question answered on its own page (#539): this phone's Done is an answer with
 * `done: true` and nothing else, and another device's reads as answered on that page.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DoneTest {
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
    fun doneIsAnAnswerWithNoPick() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machineSign = sodium.signKeyPair()
        val machineBox: KeyPair = sodium.boxKeyPair()
        val machine = Member("m_box", "machine", "box", toB64(machineBox.public), toB64(machineSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)

        fun decision(id: String) = envelopes.seal("decision", buildJsonObject {
            put("v", 1); put("id", id); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Which layout?"); put("context", ""); putJsonArray("options") {}
            putJsonObject("source") { put("machine", "box"); put("project", "p"); put("session", "s") }
            putJsonObject("answerIn") { put("url", "https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYd") }
            put("done", true)
        }, machine.id, machineSign.secret, listOf(phone))
        fun listed(vararg items: Pair<SealedItem, Boolean>) = buildJsonObject {
            put("items", buildJsonArray {
                for ((i, p) in items.withIndex()) add(buildJsonObject {
                    put("item", ProtocolJson.encodeToJsonElement(p.first)); put("cursor", "${i + 1}"); put("receivedAt", at)
                    if (p.second) put("answeredAt", at)
                })
            })
            put("cursor", "${items.size}")
        }
        var served = listed(decision("d_mine") to false)
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }
        val posted = java.util.concurrent.LinkedBlockingQueue<String>()

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                "/v1/items" -> if (request.method == "POST") {
                    posted += request.body!!.utf8()
                    json(buildJsonObject {})
                } else json(if (request.url.queryParameter("kind")!!.startsWith("decision")) served else empty)
                "/v1/quota" -> json(empty)
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()

        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        val disk = Disk(Files.createTempDirectory("starbridge").toFile(), identity)
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

        store.refresh()
        until { store.decisions.value.isNotEmpty() }
        assertTrue(store.decisions.value.single().takesDone)

        // Neither choice nor text: Done, sealed to the machine with `done: true` alone.
        store.answer("d_mine", null, null)
        val item = ProtocolJson.decodeFromString(SealedItem.serializer(), posted.poll(10, java.util.concurrent.TimeUnit.SECONDS)!!)
        val sent = envelopes.open(item, machine.id, machineBox, dir).body as dev.starbridge.app.protocol.Answer
        assertEquals(true, sent.done)
        assertNull(sent.choice)
        assertNull(sent.text)
        until { store.decisions.value.single().answer != null }
        assertEquals("Answered in the artifact", store.decisions.value.single().answer)

        // Another device's Done: the machine's notice names the device and no pick.
        val notice = envelopes.seal("settled", buildJsonObject {
            put("v", 1); put("id", "s_done"); put("itemId", "d_theirs"); putJsonArray("to") { add("phone") }; put("at", at)
            put("outcome", "device"); put("device", "tablet")
        }, machine.id, machineSign.secret, listOf(phone))
        served = listed(notice to false, decision("d_theirs") to true)
        store.refresh()
        until { store.decisions.value.any { it.id == "d_theirs" && it.theirAnswer != null } }
        val theirs = store.decisions.value.single { it.id == "d_theirs" }
        assertEquals("Answered in the artifact", theirs.theirAnswer)
        assertEquals("tablet", theirs.answeredOn)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

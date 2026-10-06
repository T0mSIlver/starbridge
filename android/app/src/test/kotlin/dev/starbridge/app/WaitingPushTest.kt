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
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
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

/**
 * A question asked already waiting (`ask --waiting`) pushes only its waiting state: the phone
 * fetches the decision it has not seen and notifies it as waiting.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WaitingPushTest {
    // Removed after each test, failed or not (#313).
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
    fun aWaitingPushForAnUnseenDecisionNotifiesItAsWaiting() {
        val account = "acct"
        val at = "2026-10-05T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machineSign = sodium.signKeyPair()
        val machine = Member("m_box", "machine", "devbox", toB64(sodium.boxKeyPair().public), toB64(machineSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)

        val decision = envelopes.seal("decision", buildJsonObject {
            put("v", 1)
            put("id", "d_waiting1")
            putJsonArray("to") { add(kotlinx.serialization.json.JsonPrimitive("phone")) }
            put("createdAt", at)
            put("question", "Merge #12 now?")
            put("context", "")
            putJsonArray("options") { add(kotlinx.serialization.json.JsonPrimitive("Merge")); add(kotlinx.serialization.json.JsonPrimitive("Wait")) }
            put("recommended", "Merge")
            putJsonObject("source") { put("machine", "devbox"); put("project", "p"); put("session", "s") }
        }, machine.id, machineSign.secret, listOf(phone))
        val waiting = envelopes.seal("waiting", buildJsonObject {
            put("v", 1)
            put("id", "w_waiting1")
            put("decisionId", "d_waiting1")
            putJsonArray("to") { add(kotlinx.serialization.json.JsonPrimitive("phone")) }
            put("at", at)
            put("state", "waiting")
        }, machine.id, machineSign.secret, listOf(phone))

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> {
                    val from = request.url.queryParameter("from")!!.toInt()
                    json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                }
                "/v1/items/d_waiting1" -> json(buildJsonObject {
                    put("item", ProtocolJson.encodeToJsonElement(decision))
                    put("cursor", "1")
                    put("receivedAt", at)
                })
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
        val notified = mutableListOf<Decision>()
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) { notified += decision }
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)

        val payload = buildJsonObject {
            put("v", 1)
            put("kind", "waiting")
            put("id", waiting.id)
            put("from", machine.id)
            put("re", "d_waiting1")
            put("box", waiting.boxes.single().box)
        }
        runBlocking { store.onPush(payload.toString()) }
        assertEquals(listOf("Merge #12 now?" to true), notified.map { it.question to it.waiting })
    }
}

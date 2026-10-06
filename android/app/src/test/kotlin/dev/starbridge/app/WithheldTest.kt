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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * A machine's signed head exposes a revocation the server withholds from the phone (#362): every
 * machine's items are held until the server serves it, then the revoked machine's no longer open.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WithheldTest {
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
    fun aWithheldRevocationHoldsEveryMachinesItems() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val revokedSign = sodium.signKeyPair()
        val honestSign = sodium.signKeyPair()
        val revoked = Member("m_revoked", "machine", "revoked", toB64(sodium.boxKeyPair().public), toB64(revokedSign.public))
        val honest = Member("m_honest", "machine", "honest", toB64(sodium.boxKeyPair().public), toB64(honestSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        for (m in listOf(revoked, honest)) entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, m, at))
        val known = directories.verify(entries, account, null)
        val full = entries + envelopeJson(directories.revokeEntry(known, "phone", signKeys.secret, revoked.id, at))
        val fullDir = directories.verify(full, account, null)

        fun decision(id: String, by: Member, key: ByteArray, head: Boolean) = envelopes.seal("decision", buildJsonObject {
            put("v", 1); put("id", id); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Deploy?"); put("context", ""); putJsonArray("options") { add("Yes"); add("No") }; put("recommended", "Yes")
            putJsonObject("source") { put("machine", by.name); put("project", "p"); put("session", "s") }
            if (head) putJsonObject("dir") { put("length", fullDir.length); put("head", fullDir.head) }
        }, by.id, key, listOf(phone))
        val first = buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(decision("d_revoked", revoked, revokedSign.secret, false))); put("cursor", "1"); put("receivedAt", at) }
        val second = buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(decision("d_honest", honest, honestSign.secret, true))); put("cursor", "2"); put("receivedAt", at) }
        var page = buildJsonObject { put("items", buildJsonArray { add(first) }); put("cursor", "1") }
        var posts = 0
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }
        var served: List<JsonElement> = entries.toList()

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray { served.drop(request.url.queryParameter("from")!!.toInt()).forEach { add(it) } }) })
                "/v1/items" -> if (request.method == "POST") { posts++; json(buildJsonObject { put("cursor", "3") }) }
                    else json(if (request.url.queryParameter("kind")!!.startsWith("decision") && request.url.queryParameter("after").orEmpty() < "2") page else empty)
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
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(known.length, known.head), entries = entries.toList()))
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

        // The revoked machine's question arrives first, before anything shows the gap.
        store.refresh()
        until { store.decisions.value.isNotEmpty() }
        // The server keeps the revocation from the phone: the honest machine's head shows it.
        page = buildJsonObject { put("items", buildJsonArray { add(second) }); put("cursor", "2") }
        store.refresh()
        until { store.notice.value != null }
        assertTrue(store.notice.value!!.contains("holding back changes to your devices that honest has seen"))
        assertTrue(store.decisions.value.isEmpty())
        // The question the phone already holds cannot be answered meanwhile.
        assertTrue(runBlocking { store.send("d_revoked", "Yes", null) } is Sent.Failed)
        assertEquals(0, posts)

        // Served in full, the hold ends and the revoked machine's question no longer opens.
        served = full
        store.refresh()
        until { store.decisions.value.any { it.id == "d_honest" } }
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * A settled notice closes only the decisions of the machine that signed it (#362): a revoked
 * machine whose revocation the server withholds cannot close another machine's question.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SettledTest {
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
    fun anotherMachinesNoticeClosesNothing() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val asksSign = sodium.signKeyPair()
        val closesSign = sodium.signKeyPair()
        val asks = Member("m_asks", "machine", "asks", toB64(sodium.boxKeyPair().public), toB64(asksSign.public))
        val closes = Member("m_closes", "machine", "closes", toB64(sodium.boxKeyPair().public), toB64(closesSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        for (m in listOf(asks, closes)) entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, m, at))
        val dir = directories.verify(entries, account, null)

        val decision = envelopes.seal("decision", buildJsonObject {
            put("v", 1); put("id", "d_asked"); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Deploy?"); put("context", ""); putJsonArray("options") { add("Yes"); add("No") }; put("recommended", "Yes")
            putJsonObject("source") { put("machine", "asks"); put("project", "p"); put("session", "s") }
        }, asks.id, asksSign.secret, listOf(phone))
        val settled = envelopes.seal("settled", buildJsonObject {
            put("v", 1); put("id", "s_forged"); put("itemId", "d_asked"); putJsonArray("to") { add("phone") }; put("at", at); put("outcome", "withdrawn")
        }, closes.id, closesSign.secret, listOf(phone))
        fun page(notice: SealedItem) = buildJsonObject {
            put("items", buildJsonArray {
                add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(notice)); put("cursor", "1"); put("receivedAt", at) })
                add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(decision)); put("cursor", "2"); put("receivedAt", at); put("answeredAt", at) })
            })
            put("cursor", "2")
        }
        var served = page(settled)
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                "/v1/items" -> json(if (request.url.queryParameter("kind")!!.startsWith("decision")) served else empty)
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
        until { disk.saved()!!.decisions.isNotEmpty() }
        val saved = disk.saved()!!.decisions.single()
        assertEquals(asks.id, saved.from)
        assertNull(saved.settled)

        // A device's answer the asking machine took: its notice says which, whenever it comes,
        // and another machine's says nothing (#330).
        fun took(by: Member, key: ByteArray, choice: String) = envelopes.seal("settled", buildJsonObject {
            put("v", 1); put("id", "s_$choice"); put("itemId", "d_asked"); putJsonArray("to") { add("phone") }; put("at", at)
            put("outcome", "device"); put("device", "tablet"); put("choice", choice)
        }, by.id, key, listOf(phone))
        // The other machine's notice lists last, so it would win were it counted.
        served = buildJsonObject {
            put("items", buildJsonArray {
                for ((i, n) in listOf(took(asks, asksSign.secret, "No"), took(closes, closesSign.secret, "Yes")).withIndex())
                    add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(n)); put("cursor", "${i + 1}"); put("receivedAt", at) })
                add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(decision)); put("cursor", "3"); put("receivedAt", at); put("answeredAt", at) })
            })
            put("cursor", "3")
        }
        store.refresh()
        until { store.decisions.value.single().theirAnswer != null }
        val won = store.decisions.value.single()
        assertEquals("No", won.theirAnswer)
        assertEquals("tablet", won.answeredOn)
        assertNull(won.settled)

        // The asking machine's own notice still closes it.
        served = page(envelopes.seal("settled", buildJsonObject {
            put("v", 1); put("id", "s_own"); put("itemId", "d_asked"); putJsonArray("to") { add("phone") }; put("at", at); put("outcome", "withdrawn")
        }, asks.id, asksSign.secret, listOf(phone)))
        store.refresh()
        until { disk.saved()!!.decisions.single().settled != null }
        assertEquals("withdrawn", disk.saved()!!.decisions.single().settled)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

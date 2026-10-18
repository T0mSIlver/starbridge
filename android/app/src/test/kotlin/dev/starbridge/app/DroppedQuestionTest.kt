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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/**
 * An open question kept on the phone that the server no longer holds, deleted by its retention,
 * leaves the inbox on the next run's first sync, as on the web (#1980).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DroppedQuestionTest {
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
    fun anOpenQuestionTheServerDroppedLeavesTheInbox() {
        val account = "acct"
        val at = "2026-09-01T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machineSign = sodium.signKeyPair()
        val machine = Member("m_box", "machine", "box", toB64(sodium.boxKeyPair().public), toB64(machineSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)
        fun body(id: String) = buildJsonObject {
            put("v", 1); put("id", id); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Deploy?"); put("context", ""); putJsonArray("options") { add("Yes"); add("No") }; put("recommended", "Yes")
            putJsonObject("source") { put("machine", "box"); put("project", "p"); put("session", "s") }
        }
        val still = envelopes.seal("decision", body("d_still"), machine.id, machineSign.secret, listOf(phone))
        val openReads = AtomicInteger()
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                "/v1/items" -> if (request.url.queryParameter("open") == "1") {
                    openReads.incrementAndGet()
                    // The server still holds d_still open; d_gone went with its retention.
                    json(buildJsonObject {
                        put("items", buildJsonArray { add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(still)); put("cursor", "1"); put("receivedAt", at) }) })
                        put("cursor", "1")
                    })
                } else json(buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") })
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()
        val disk = Disk(tmp.newFolder(), object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        })
        val server = http.url("/").toString().trimEnd('/')
        val kept = listOf("d_gone", "d_still").map { SavedDecision(machine.id, body(it).toString()) } +
            SavedDecision(machine.id, body("d_answered").toString(), answeredAt = at, answer = "Yes")
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList(), cursor = "9", decisions = kept))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val cancelled = java.util.Collections.synchronizedList(mutableListOf<String>())
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) { cancelled += id }
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)

        assertEquals(setOf("d_gone", "d_still", "d_answered"), store.decisions.value.map { it.id }.toSet())
        store.refresh()
        // Gone from the inbox and its notification; an answered one stays in History.
        until { store.decisions.value.map { it.id }.toSet() == setOf("d_still", "d_answered") }
        assertEquals(listOf("d_gone"), cancelled.toList())
        // Once a run: the next sync reads no open list.
        store.refresh()
        Thread.sleep(500)
        assertEquals(1, openReads.get())
    }
}

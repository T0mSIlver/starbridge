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
import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * An answered question lists without its images (`blobs=open`, #1382): they hold their place,
 * and download, checked against the signed hash, once its sheet asks (#1464).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AnsweredImagesTest {
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
    fun anAnsweredQuestionsImagesDownloadWhenShown() {
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

        // An image the protocol's vectors seal, with its bytes.
        val vectors = File(System.getProperty("starbridge.vectors") ?: error("starbridge.vectors not set"))
        val case = ProtocolJson.parseToJsonElement(File(vectors, "images.json").readText()).jsonObject
            .getValue("cases").jsonArray.map { it.jsonObject }.first { it.getValue("expect").jsonPrimitive.content == "ok" }
        val ref = case.getValue("ref").jsonObject
        val blob = case.getValue("blob").jsonPrimitive.content
        val pictured = envelopes.seal("decision", buildJsonObject {
            put("v", 1); put("id", "d_pic"); putJsonArray("to") { add("phone") }; put("createdAt", at)
            put("question", "Which one?"); put("context", ""); putJsonArray("options") {}
            putJsonObject("source") { put("machine", "box"); put("project", "p"); put("session", "s") }
            putJsonArray("images") {
                add(buildJsonObject {
                    put("type", "image/png"); put("width", 1); put("height", 1)
                    put("key", ref.getValue("key").jsonPrimitive.content); put("hash", ref.getValue("hash").jsonPrimitive.content)
                })
            }
        }, machine.id, machineSign.secret, listOf(phone))
        fun listed(item: SealedItem) = buildJsonObject {
            put("item", ProtocolJson.encodeToJsonElement(item)); put("cursor", "1"); put("receivedAt", at); put("answeredAt", at)
        }
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }
        val asked = java.util.concurrent.CopyOnWriteArrayList<String>()

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                "/v1/items" -> if (request.url.queryParameter("kind")!!.startsWith("decision")) {
                    asked += request.url.queryParameter("blobs") ?: ""
                    // Answered, listed without its blobs.
                    json(buildJsonObject { put("items", buildJsonArray { add(listed(pictured)) }); put("cursor", "1") })
                } else json(empty)
                "/v1/items/d_pic" -> {
                    asked += "item"
                    json(listed(pictured.copy(blobs = listOf(blob))))
                }
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
        assertEquals(listOf("open"), asked.toList())
        // Its place, at its shape, with nothing in it yet.
        assertEquals(listOf(""), store.decisions.value.single().images.map { it.data })

        store.loadImages("d_pic")
        until { store.decisions.value.single().images.single().data.isNotEmpty() }
        assertEquals(case.getValue("plain").jsonPrimitive.content, store.decisions.value.single().images.single().data)
        // Kept: showing it again fetches nothing.
        store.loadImages("d_pic")
        store.refresh()
        until { asked.size == 3 }
        assertEquals(listOf("open", "item", "open"), asked.toList())
        until { disk.load().first?.decisions?.single()?.images?.singleOrNull() != null }
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

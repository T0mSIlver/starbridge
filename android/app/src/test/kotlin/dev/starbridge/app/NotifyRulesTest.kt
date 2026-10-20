package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Notified
import dev.starbridge.app.data.NotifyEvent
import dev.starbridge.app.data.notifyStep
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import java.io.File

/**
 * rules.json's notify cases (#2151), which the web's and iOS's tests run too: through the rule's
 * Kotlin version, and through the store's push handler, where a restart is a new store on the
 * same files, as after the process ends.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class NotifyRulesTest {
    @get:Rule val tmp = TemporaryFolder()
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scopes = mutableListOf<CoroutineScope>()
    private val http = MockWebServer()

    @After
    fun stop() {
        scopes.forEach { it.cancel() }
        http.close()
    }

    private val cases = Json.parseToJsonElement(
        File(System.getProperty("starbridge.vectors") ?: error("starbridge.vectors not set"), "rules.json").readText(),
    ).jsonObject.getValue("notify").jsonArray

    private val account = "acct"
    private val at = "2026-10-12T09:00:00Z"
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
    private val question: SealedItem = envelopes.seal("decision", buildJsonObject {
        put("v", 1)
        put("id", "d_1")
        putJsonArray("to") { add(JsonPrimitive("phone")); add(JsonPrimitive("web")) }
        put("createdAt", at)
        put("question", "Publish 0.1.1?")
        put("context", "")
        putJsonArray("options") { add(JsonPrimitive("Publish")); add(JsonPrimitive("Wait")) }
        put("recommended", "Publish")
        putJsonObject("source") { put("machine", "devbox"); put("project", "p"); put("session", "s") }
    }, machine.id, machineSign.secret, listOf(phone, web))
    private var rings = 0
    private var quiet = 0

    private fun json(body: JsonElement) = MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    private fun serve() {
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> {
                    val from = request.url.queryParameter("from")!!.toInt()
                    json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                }
                "/v1/items/d_1" -> json(buildJsonObject {
                    put("item", ProtocolJson.encodeToJsonElement(SealedItem.serializer(), question))
                    put("cursor", "1")
                    put("receivedAt", at)
                })
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()
    }

    private fun store(disk: Disk): ServerStore {
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) { if (silent) quiet++ else rings++ }
            override fun back(decision: Decision) { rings++ }
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes += it }
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", http.url("/").toString().trimEnd('/'), false, scope)
    }

    private fun sealedPush(kind: String, item: SealedItem, extra: JsonObject = JsonObject(emptyMap())) = buildJsonObject {
        put("v", 1)
        put("kind", kind)
        put("id", item.id)
        put("from", item.from)
        item.re?.let { put("re", it) }
        item.wakeAt?.let { put("wakeAt", it) }
        for ((k, v) in extra) put(k, v)
        put("box", item.boxes.single { it.to == "phone" }.box)
    }.toString()

    private var flips = 0

    /** The push as the server sends it for [p], a step's push. */
    private fun payload(p: JsonObject): String = when (p.getValue("kind").jsonPrimitive.content) {
        "decision" -> sealedPush("decision", question)
        "answered" -> buildJsonObject { put("v", 1); put("kind", "answered"); put("id", "d_1") }.toString()
        "waiting" -> sealedPush("waiting", envelopes.seal("waiting", buildJsonObject {
            put("v", 1)
            put("id", "w_${flips++}")
            put("decisionId", "d_1")
            putJsonArray("to") { add(JsonPrimitive("phone")); add(JsonPrimitive("web")) }
            put("at", p.getValue("at").jsonPrimitive.content)
            put("state", p.getValue("state").jsonPrimitive.content)
        }, machine.id, machineSign.secret, listOf(phone, web)).copy(re = "d_1"))
        else -> {
            val z = envelopes.seal("snooze", buildJsonObject {
                put("v", 1)
                put("id", "z_1")
                put("decisionId", "d_1")
                putJsonArray("to") { listOf(machine, phone, web).forEach { add(JsonPrimitive(it.id)) } }
                put("until", p.getValue("until").jsonPrimitive.content)
                put("at", p.getValue("at").jsonPrimitive.content)
            }, web.id, webSign.secret, listOf(machine, phone, web))
            sealedPush("snooze", z.copy(re = "d_1"), buildJsonObject { put("due", p.getValue("due").jsonPrimitive.boolean) })
        }
    }

    /** The rule itself, as notify.ts's test runs it; a restart is a round trip through JSON. */
    @Test
    fun theRule() {
        for (c in cases) {
            val name = c.jsonObject.getValue("name").jsonPrimitive.content
            var kept = Notified()
            for ((i, step) in c.jsonObject.getValue("steps").jsonArray.withIndex()) {
                val s = step.jsonObject
                if ("restart" in s) {
                    kept = Json.decodeFromString(Notified.serializer(), Json.encodeToString(Notified.serializer(), kept))
                    continue
                }
                val p = s.getValue("push").jsonObject
                val str = { k: String -> p.getValue(k).jsonPrimitive.content }
                val event = when (str("kind")) {
                    "decision" -> NotifyEvent.Asked
                    "answered" -> NotifyEvent.Closed
                    "waiting" -> NotifyEvent.Flip(str("at"), str("state"))
                    else -> NotifyEvent.Return(str("at"), p.getValue("due").jsonPrimitive.boolean)
                }
                val (next, effect) = notifyStep(kept, event)
                assertEquals("$name, step $i", s.getValue("effect").jsonPrimitive.content, effect.name.lowercase())
                kept = next
            }
        }
    }

    /** The cases through the store's push handler, with what the store keeps on disk. */
    @Test
    fun everyCase() {
        serve()
        for (c in cases) {
            val name = c.jsonObject.getValue("name").jsonPrimitive.content
            val disk = Disk(tmp.newFolder(), object : Vault {
                override fun wrap(plain: ByteArray) = plain
                override fun unwrap(wrapped: ByteArray) = wrapped
            })
            disk.save(Saved(http.url("/").toString().trimEnd('/'), account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList()))
            disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
            var store = store(disk)
            for ((i, step) in c.jsonObject.getValue("steps").jsonArray.withIndex()) {
                val s = step.jsonObject
                if ("restart" in s) {
                    store = store(disk)
                    continue
                }
                val before = rings to quiet
                runBlocking { store.onPush(payload(s.getValue("push").jsonObject)) }
                val effect = if (rings > before.first) "ring" else if (quiet > before.second) "quiet" else "none"
                assertEquals("$name, step $i", s.getValue("effect").jsonPrimitive.content, effect)
            }
        }
    }
}

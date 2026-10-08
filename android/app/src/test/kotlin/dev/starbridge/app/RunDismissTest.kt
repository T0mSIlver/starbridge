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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Dismissing a run (#827): this phone drops it at once and asks the server to drop it for every
 * device; a run another device dismissed leaves at the next sync; a newer update brings it back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RunDismissTest {
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

    private val account = "acct"
    private val at = "2026-10-08T12:00:00Z"
    private val signKeys = sodium.signKeyPair()
    private val boxKeys = sodium.boxKeyPair()
    private val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
    private val machineSign = sodium.signKeyPair()
    private val machine = Member("m_box", "machine", "devbox", toB64(sodium.boxKeyPair().public), toB64(machineSign.public))
    private val entries = mutableListOf<JsonElement>().apply {
        add(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        add(envelopeJson(directories.addEntry(directories.verify(this, account, null), "phone", signKeys.secret, machine, at)))
    }
    private val dir = directories.verify(entries, account, null)

    /** What the server lists for runs, and the requests it got. */
    private val listed = CopyOnWriteArrayList<SealedItem>()
    private val deleted = CopyOnWriteArrayList<String>()
    private val cancelled = CopyOnWriteArrayList<String>()
    private val runReads = java.util.concurrent.atomic.AtomicInteger()

    /** A run that failed [minutesAgo] minutes ago, last updated then. */
    private fun run(id: String, minutesAgo: Long): SealedItem {
        val ended = Instant.now().minusSeconds(minutesAgo * 60).toString()
        return envelopes.seal("run", buildJsonObject {
            put("v", 1)
            put("id", id)
            putJsonArray("to") { add(JsonPrimitive("phone")) }
            put("title", "Android e2e")
            put("reason", "runs the emulator")
            putJsonObject("source") { put("machine", "devbox"); put("project", "p"); put("session", "s") }
            put("startedAt", Instant.now().minusSeconds(minutesAgo * 60 + 300).toString())
            put("at", ended)
            putJsonObject("exit") { put("code", 1); put("at", ended) }
        }, machine.id, machineSign.secret, listOf(phone))
    }

    private fun json(body: String) = MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), body)

    private fun store(): ServerStore {
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> {
                    val from = request.url.queryParameter("from")!!.toInt()
                    json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) }.toString())
                }
                "/v1/items" -> json(
                    buildJsonObject {
                        put("cursor", "1")
                        put("items", buildJsonArray {
                            if (request.url.queryParameter("kind") == "run") runReads.incrementAndGet()
                            if (request.url.queryParameter("kind") == "run") listed.forEach { item ->
                                add(buildJsonObject { put("item", ProtocolJson.encodeToJsonElement(SealedItem.serializer(), item)); put("cursor", "1"); put("receivedAt", at) })
                            }
                        })
                    }.toString(),
                )
                "/v1/quota" -> json("""{"items":[]}""")
                else -> if (request.method == "DELETE" && request.url.encodedPath.startsWith("/v1/items/")) {
                    deleted += request.url.encodedPath.removePrefix("/v1/items/")
                    MockResponse(204, okhttp3.Headers.headersOf(), "")
                } else MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()
        val disk = Disk(tmp.newFolder(), object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        })
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
            override fun cancelRun(id: String) { cancelled += id }
        }
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
    }

    private fun ServerStore.shown() = runs.value.map { it.id }

    /** Syncs once, through the read of runs, and checks what shows. */
    private fun ServerStore.synced(expected: List<String>) {
        val reads = runReads.get()
        refresh(shown = false)
        waitUntil { runReads.get() > reads && shown() == expected }
    }

    @Test
    fun dismissedHereItLeavesEveryDeviceAndStaysOutUntilANewerUpdate() {
        listed += run("r1", 5)
        val store = store()
        store.synced(listOf("r1"))

        store.dismissRun("r1")
        waitUntil { deleted == listOf("r1") }
        assertEquals(emptyList<String>(), store.shown())
        assertEquals(listOf("r1"), cancelled)

        // A server without the route still lists it: this phone keeps it out.
        store.synced(emptyList())

        // Its machine posted again: a newer update brings it back.
        listed.clear()
        listed += run("r1", 1)
        store.synced(listOf("r1"))
    }

    @Test
    fun dismissedOnAnotherDeviceItLeavesAtTheNextSync() {
        listed += run("r1", 5)
        listed += run("r2", 4)
        val store = store()
        store.synced(listOf("r1", "r2"))
        listed.removeIf { it.id == "r1" }
        store.synced(listOf("r2"))
        assertTrue("r1" in cancelled)
    }

    private fun waitUntil(condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!condition()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(20)
        }
    }
}

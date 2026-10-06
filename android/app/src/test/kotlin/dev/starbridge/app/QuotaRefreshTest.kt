package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.SavedQuota
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.QuotaProvider
import dev.starbridge.app.protocol.QuotaSnapshot
import dev.starbridge.app.protocol.QuotaWindow
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
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/** Pull to refresh on Quotas ends however the ask and the sync after it go (#303). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class QuotaRefreshTest {
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

    private fun json(body: JsonElement, code: Int = 200) = MockResponse(code, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    private val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }

    @Test
    fun endsWhenTheMachinesAnswer() {
        val store = readyStore { path ->
            when (path) {
                "/v1/quota/ask" -> json(buildJsonObject { put("askedAt", "2026-10-06T12:00:00Z"); put("behind", 0) })
                else -> null
            }
        }
        refreshAndWait(store)
        assertNull(store.notice.value)
    }

    @Test
    fun endsWhenTheServerFails() {
        val store = readyStore { path -> if (path == "/v1/quota/ask" || path == "/v1/quota") MockResponse(500, okhttp3.Headers.headersOf(), "") else null }
        refreshAndWait(store)
        assertNotNull(store.notice.value)
    }

    @Test
    fun endsWithNoMachinesAndNoQuotas() {
        // A server without asks, and nothing posted: the sync finds no windows.
        val store = readyStore { path -> if (path == "/v1/quota/ask") MockResponse(404, okhttp3.Headers.headersOf(), "") else null }
        refreshAndWait(store)
        assertEquals(emptyList<Any>(), store.windows.value)
        assertNull(store.notice.value)
    }

    @Test
    fun aSnapshotThatFailsToOpenKeepsTheMachinesLastGoodOne() {
        // A newer machine's snapshot this app cannot open (#472): the windows stay as they were.
        val bad = buildJsonObject {
            put("items", buildJsonArray {
                add(buildJsonObject {
                    put("item", buildJsonObject {
                        put("v", 1); put("kind", "quota"); put("id", "q_new"); put("from", "m_box")
                        put("boxes", buildJsonArray { add(buildJsonObject { put("to", "phone"); put("box", "AAAA") }) })
                    })
                    put("cursor", "1"); put("receivedAt", "2026-10-06T12:05:00Z")
                })
            })
        }
        val good = QuotaSnapshot(
            1, "q_old", listOf("phone"), "2026-10-06T12:00:00Z",
            listOf(QuotaProvider("zai", windows = listOf(QuotaWindow("primary", "5h", 20.0, 300, null, null)))),
            emptyList(),
        )
        val store = readyStore(listOf(SavedQuota("m_box", good))) { path ->
            when (path) {
                "/v1/quota/ask" -> MockResponse(404, okhttp3.Headers.headersOf(), "")
                "/v1/quota" -> json(bad)
                else -> null
            }
        }
        refreshAndWait(store)
        assertEquals(listOf("zai"), store.windows.value.map { it.provider })
    }

    @Test
    fun aServerThatRefusesThisReleaseAsksForAnUpdate() {
        // Every route answers 426 below the server's minimum (#497): the app shows only the update screen.
        val store = readyStore { path ->
            if (path.startsWith("/v1/")) json(buildJsonObject { put("error", "client-too-old"); put("detail", "update"); put("client", "android"); put("minimum", "1.2.0") }, 426) else null
        }
        refreshAndWait(store)
        assertEquals("1.2.0", store.tooOld.value)
    }

    private fun refreshAndWait(store: ServerStore) {
        store.refreshQuotas()
        // Busy holds from the ask to the end of the sync, so it clears only once both ran.
        until { http.requestCount > 0 && !store.busy.value }
    }

    /** A phone in an account with one machine; [route] answers first, else empty lists. */
    private fun readyStore(quotas: List<SavedQuota> = emptyList(), route: (String) -> MockResponse?): ServerStore {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val machine = Member("m_box", "machine", "devbox", toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        entries += envelopeJson(directories.addEntry(directories.verify(entries, account, null), "phone", signKeys.secret, machine, at))
        val dir = directories.verify(entries, account, null)

        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return route(path) ?: when (path) {
                    "/v1/directory" -> json(buildJsonObject { put("entries", buildJsonArray {}) })
                    "/v1/items", "/v1/quota" -> json(empty)
                    else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
                }
            }
        }
        http.start()

        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        val disk = Disk(Files.createTempDirectory("starbridge").toFile(), identity)
        val server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList(), quotas = quotas))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "the refresh never ended" }
            Thread.sleep(10)
        }
    }
}

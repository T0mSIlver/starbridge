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
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertNull

/**
 * A resume while Android has no validated network waits for one, then syncs, and says nothing
 * meanwhile: a phone unlocked a moment before its VPN is back used to show the lookup's error (#920).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OfflineResumeTest {
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
    fun aResumeOfflineWaitsForTheNetworkThenSyncs() {
        val account = "acct"
        val at = "2026-10-06T12:00:00Z"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)))
        val dir = directories.verify(entries, account, null)
        val empty = buildJsonObject { put("items", buildJsonArray {}); put("cursor", "") }
        val calls = AtomicInteger()
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls.incrementAndGet()
                return when (request.url.encodedPath) {
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
        val network = MutableStateFlow(false)
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope, network = network)
        store.pollMs = 60_000

        // As onResume does: a sync, then the app counts as in front.
        store.refresh(shown = false)
        store.foreground(true)
        Thread.sleep(300)
        assertEquals(0, calls.get())

        // The network is back: the sync goes, and no notice or connection message ever showed.
        network.value = true
        until { calls.get() > 0 && !store.busy.value }
        assertNull(store.notice.value)
        assertNull(store.connection.value)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

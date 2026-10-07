package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.Sodium
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The account's first entry reaches the server only once the recovery key is confirmed (#370),
 * and an app killed before that shows the same key again.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FirstDeviceTest {
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

    private fun json(body: JsonElement, code: Int = 200) = MockResponse(code, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    private val account = "acct"
    private lateinit var disk: Disk
    private lateinit var server: String
    private lateinit var open: () -> ServerStore

    @Test
    fun theFirstEntryWaitsForTheConfirmedKey() {
        val entries = java.util.concurrent.CopyOnWriteArrayList<JsonElement>()
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/v1/directory" && request.method == "GET" -> {
                        val from = request.url.queryParameter("from")!!.toInt()
                        json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                    }
                    path == "/v1/directory" -> {
                        entries += ProtocolJson.parseToJsonElement(request.body!!.utf8()).jsonObject.getValue("entry")
                        val dir = directories.verify(entries, account, null)
                        json(buildJsonObject { put("length", dir.length); put("head", dir.head) }, 201)
                    }
                    path == "/v1/auth/owner" -> json(buildJsonObject { put("session", "s2") })
                    // The server names another account than the one this phone was set up with.
                    path == "/v1/me" -> json(buildJsonObject { put("account", "other"); put("member", null as String?); put("role", "device") })
                    else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
                }
            }
        }
        http.start()

        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        disk = Disk(tmp.newFolder(), identity)
        server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = account))
        disk.save(Secrets(session = "s"))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        open = { ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope) }

        val first = open()
        first.setUpFirstDevice()
        until { first.phase.value is Phase.RecoveryKey && !first.busy.value }
        assertEquals(emptyList<JsonElement>(), entries)

        // Killed on the recovery key: the next start shows the same key, still unposted.
        val shown = first.phase.value
        val again = open()
        assertEquals(shown, again.phase.value)
        assertEquals(emptyList<JsonElement>(), entries)

        again.confirmRecoveryKey()
        until { again.phase.value == Phase.Ready }
        assertEquals(1, entries.size)
        assertEquals(disk.saved()!!.me!!.id, directories.verify(entries, account, null).members.keys.single())
    }

    @Test
    fun theServersWordOnTheAccountUnpairsNothing() {
        theFirstEntryWaitsForTheConfirmedKey()
        val before = disk.saved()!!
        val store = open()
        until { store.phase.value == Phase.Ready }
        store.signInWithOwnerToken(server, "token")
        until { !store.busy.value && store.notice.value != null }
        // Refused, not wiped: the keys, the pin and the account stay (#808).
        assertEquals(before.me, disk.saved()!!.me)
        assertEquals(before.pin, disk.saved()!!.pin)
        assertEquals(account, disk.saved()!!.account)
        assertNotNull(disk.secrets().signSk)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

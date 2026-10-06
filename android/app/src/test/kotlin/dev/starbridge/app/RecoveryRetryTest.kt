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
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.recoverySignSeed
import dev.starbridge.app.protocol.toB64
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
import mockwebserver3.SocketEffect
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
 * Recovery against a scripted server that commits the first append but loses its reply (#274):
 * the retry finds the member already in the chain and keeps the keys the session was bound to.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RecoveryRetryTest {
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

    private fun json(body: JsonElement, code: Int = 200) = MockResponse(code, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    @Test
    fun aRetryAfterALostReplyKeepsTheFirstKeys() {
        val account = "acct"
        val seed = sodium.random(16)
        val key = RecoveryKeys.encode(seed, sodium)
        val lost = Member("lost", "device", "Lost phone", toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public))
        val lostSign = sodium.signKeyPair()
        val genesis = directories.genesisEntry(account, lost.copy(signPk = toB64(lostSign.public)), lostSign.secret, sodium.signSeedKeyPair(recoverySignSeed(seed, sodium)), "2026-10-05T12:00:00Z")
        val entries = mutableListOf<JsonElement>(envelopeJson(genesis))

        var appends = 0
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/v1/directory" && request.method == "GET" -> {
                        val from = request.url.queryParameter("from")!!.toInt()
                        json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                    }
                    path == "/v1/directory" -> {
                        appends++
                        val entry = ProtocolJson.parseToJsonElement(request.body!!.utf8()).jsonObject.getValue("entry")
                        entries += entry
                        val dir = directories.verify(entries, account, null)
                        val reply = json(buildJsonObject { put("length", dir.length); put("head", dir.head) }, 201)
                        // The first append commits, but the connection drops in the middle of its
                        // reply. Not a 503, which clients retry quietly (#250), and not before the
                        // reply starts, which OkHttp retries: either way the phone never sees it fail.
                        if (appends == 1) reply.newBuilder().onResponseBody(SocketEffect.ShutdownConnection).build() else reply
                    }
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
        disk.save(Saved(server, account = account, accountExists = true))
        disk.save(Secrets(session = "s"))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)

        store.recover(key)
        until { appends == 1 && !store.busy.value }
        store.recover(key)
        until { store.phase.value == Phase.Ready }

        assertEquals(1, appends)
        val chain = directories.verify(entries, account, null)
        val added = chain.members.values.single { it.member.id != lost.id }.member
        assertEquals(added.id, disk.saved()!!.me!!.id)
        assertEquals(added.boxPk, disk.secrets().boxPk)
        assertEquals(added.signPk, disk.secrets().signPk)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

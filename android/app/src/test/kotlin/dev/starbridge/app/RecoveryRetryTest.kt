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
import dev.starbridge.app.protocol.DirectoryEntry
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.protocol.SignedEnvelope
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
 * the retry finds the member already in the chain and keeps the keys the session was bound to,
 * unless a device rather than the recovery key added it (#1132).
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
        val r = Rig()
        // The first append commits, but the connection drops in the middle of its reply. Not a
        // 503, which clients retry quietly (#250), and not before the reply starts, which OkHttp
        // retries: either way the phone never sees it fail.
        r.start { entry -> r.entries += entry }

        r.store.recover(r.key)
        until { r.appends == 1 && !r.store.busy.value }
        r.store.recover(r.key)
        until { r.store.phase.value == Phase.Ready }

        assertEquals(1, r.appends)
        val chain = directories.verify(r.entries, r.account, null)
        val added = chain.members.values.single { it.member.id != r.lost.id }.member
        assertEquals(added.id, r.disk.saved()!!.me!!.id)
        assertEquals(added.boxPk, r.disk.secrets().boxPk)
        assertEquals(added.signPk, r.disk.secrets().signPk)
    }

    /**
     * A server holding the lost device's key drops the first attempt's `recover` entry and serves
     * a fork where that device added the same member with the same keys (#1132): the retry makes
     * new keys and recovers with them, so the lost device leaves.
     */
    @Test
    fun aMemberAnotherDeviceAddedIsNotReused() {
        val r = Rig()
        r.start { entry ->
            if (r.appends == 1) {
                val body = ProtocolJson.decodeFromString(DirectoryEntry.serializer(), ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), entry).body)
                val dir = directories.verify(r.entries, r.account, null)
                r.entries += envelopeJson(directories.addEntry(dir, r.lost.id, r.lostSign.secret, body.member!!, "2026-10-05T12:01:00Z"))
            } else {
                r.entries += entry
            }
        }

        r.store.recover(r.key)
        until { r.appends == 1 && !r.store.busy.value }
        r.store.recover(r.key)
        until { r.store.phase.value == Phase.Ready }

        assertEquals(2, r.appends)
        val chain = directories.verify(r.entries, r.account, null)
        assertEquals(false, chain.members.getValue(r.lost.id).active)
        val me = r.disk.saved()!!.me!!
        assertEquals(listOf(me.id), chain.members.values.filter { it.active }.map { it.member.id })
        assertEquals(me.signPk, r.disk.secrets().signPk)
    }

    /** An account whose only device is lost, a scripted server for it, and a phone that recovers it. */
    private inner class Rig {
        val account = "acct"
        private val seed = sodium.random(16)
        val key = RecoveryKeys.encode(seed, sodium)
        val lostSign = sodium.signKeyPair()
        val lost = Member("lost", "device", "Lost phone", toB64(sodium.boxKeyPair().public), toB64(lostSign.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, lost, lostSign.secret, sodium.signSeedKeyPair(recoverySignSeed(seed, sodium)), "2026-10-05T12:00:00Z")))
        var appends = 0
        lateinit var disk: Disk
        lateinit var store: ServerStore

        /** [onAppend] files each posted entry; the first append's reply is lost. */
        fun start(onAppend: (JsonElement) -> Unit) {
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
                            onAppend(ProtocolJson.parseToJsonElement(request.body!!.utf8()).jsonObject.getValue("entry"))
                            val dir = directories.verify(entries, account, null)
                            val reply = json(buildJsonObject { put("length", dir.length); put("head", dir.head) }, 201)
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
            disk = Disk(tmp.newFolder(), identity)
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
            store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
        }
    }
}

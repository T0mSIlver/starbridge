package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Replacing
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
import dev.starbridge.app.protocol.ProtocolException
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
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * Replacing the recovery key from this phone (#348), against a server that keeps the chain and
 * refuses what does not verify, as the real one does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RecoveryReplaceTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()
    private val account = "acct"
    private val entries = mutableListOf<JsonElement>()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private fun json(body: JsonElement, code: Int = 200) = MockResponse(code, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    private fun serve() {
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/v1/directory" && request.method == "GET" -> {
                        val from = request.url.queryParameter("from")!!.toInt()
                        json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                    }
                    path == "/v1/directory" -> {
                        val entry = ProtocolJson.parseToJsonElement(request.body!!.utf8()).jsonObject.getValue("entry")
                        val dir = try {
                            directories.verify(entries + entry, account, null)
                        } catch (e: ProtocolException) {
                            return json(buildJsonObject { put("error", e.code) }, 400)
                        }
                        entries += entry
                        json(buildJsonObject { put("length", dir.length); put("head", dir.head) }, 201)
                    }
                    else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
                }
            }
        }
        http.start()
    }

    private fun store(saved: Saved, secrets: Secrets): Pair<ServerStore, Disk> {
        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        val disk = Disk(Files.createTempDirectory("starbridge").toFile(), identity)
        disk.save(saved)
        disk.save(secrets)
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val server = http.url("/").toString().trimEnd('/')
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope) to disk
    }

    @Test
    fun theCurrentKeyReplacesItAndTheOldOneRecoversNothingAfter() {
        serve()
        val server = http.url("/").toString().trimEnd('/')
        val seed = sodium.random(16)
        val oldKey = RecoveryKeys.encode(seed, sodium)
        val box = sodium.boxKeyPair()
        val sign = sodium.signKeyPair()
        val me = Member("phone", "device", "Pixel", toB64(box.public), toB64(sign.public))
        val genesis = directories.genesisEntry(account, me, sign.secret, sodium.signSeedKeyPair(recoverySignSeed(seed, sodium)), "2026-10-06T12:00:00Z")
        entries += envelopeJson(genesis)
        val first = directories.verify(entries, account, null)
        val (phone, _) = store(
            Saved(server, account = account, accountExists = true, me = me, pin = Pin(first.length, first.head), entries = entries.toList()),
            Secrets(session = "s", boxPk = toB64(box.public), boxSk = toB64(box.secret), signPk = toB64(sign.public), signSk = toB64(sign.secret)),
        )
        until { phone.phase.value == Phase.Ready }

        // A key that is not the chain's is refused before anything is made or posted.
        phone.newRecoveryKey(RecoveryKeys.encode(sodium.random(16), sodium))
        until { phone.notice.value != null }
        assertEquals("This isn't the account's current recovery key.", phone.notice.value)
        assertEquals(Replacing.Idle, phone.replacing.value)

        phone.newRecoveryKey(oldKey)
        until { phone.replacing.value is Replacing.Shown }
        val shown = phone.replacing.value as Replacing.Shown
        assertEquals(1, entries.size)
        phone.saveRecoveryKey()
        until { phone.replacing.value is Replacing.Done }
        val newPk = toB64(sodium.signSeedKeyPair(recoverySignSeed(RecoveryKeys.seed(shown.key, sodium), sodium)).public)
        assertEquals(newPk, directories.verify(entries, account, null).recoveryPk)
        assertEquals("this phone", phone.recovery.value!!.setBy)
        assertEquals(null, phone.recovery.value!!.notice)

        // A new phone that recovers with the old key gets nothing appended.
        val (stranger, _) = store(Saved(server, account = account, accountExists = true), Secrets(session = "s2"))
        val before = entries.size
        stranger.recover(oldKey)
        until { stranger.notice.value != null }
        assertEquals("This is a recovery key, but not this account's current one.", stranger.notice.value)
        assertEquals(before, entries.size)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

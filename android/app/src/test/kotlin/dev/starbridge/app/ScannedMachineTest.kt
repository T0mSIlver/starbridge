package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Approval
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
import dev.starbridge.app.protocol.PairingMessage
import dev.starbridge.app.protocol.PairingRequestBody
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.parseJsonText
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A machine this phone approved from its QR, whose check key proved the entry, asks nothing, so
 * Devices shows no check code for it here (#1329); one approved from a typed code still does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ScannedMachineTest {
    @get:Rule val tmp = TemporaryFolder()
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val pairings = Pairings(sodium)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()
    private val vault = object : Vault {
        override fun wrap(plain: ByteArray) = plain
        override fun unwrap(wrapped: ByteArray) = wrapped
    }
    private lateinit var disk: Disk

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private val account = "acct"
    private val at = "2026-10-11T12:00:00Z"
    private val signKeys = sodium.signKeyPair()
    private val boxKeys = sodium.boxKeyPair()
    private val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
    private val entries = mutableListOf<JsonElement>(
        envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), at)),
    )
    private val code = pairings.newCode()
    private val machine = PairingRequestBody(
        1, code.rendezvous, "machine", "m_mbp", "mbp",
        toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public), at,
    )

    private fun json(text: String) = MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), text)

    private fun store(): ServerStore {
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/directory" -> if (request.method == "POST") {
                    entries += parseJsonText(request.body!!.utf8()).jsonObject.getValue("entry")
                    val dir = directories.verify(entries, account, null)
                    json(buildJsonObject { put("length", dir.length); put("head", dir.head) }.toString())
                } else {
                    val from = request.url.queryParameter("from")!!.toInt()
                    json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) }.toString())
                }
                "/v1/pairings/${code.rendezvous}" ->
                    json(buildJsonObject { put("request", ProtocolJson.encodeToJsonElement(PairingMessage.serializer(), pairings.request(machine, code))) }.toString())
                "/v1/pairings/${code.rendezvous}/approve" -> json("{}")
                else -> MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()
        disk = Disk(tmp.newFolder(), vault)
        val dir = directories.verify(entries, account, null)
        val server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries.toList()))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun back(decision: Decision) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        return ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, pairings, Joins(sodium), alerts, "Phone", server, false, scope)
    }

    /** Looks the code up and approves it, as the owner does under Add a device. */
    private fun approve(store: ServerStore, text: String) = runBlocking {
        store.lookUpPairing(text)
        withTimeout(10_000) { while (store.approval.value !is Approval.Found) delay(20) }
        store.approvePairing()
        withTimeout(10_000) { while (store.approval.value !is Approval.Done) delay(20) }
        withTimeout(10_000) { while (store.members.value.none { it.id == machine.id }) delay(20) }
        store.members.value.single { it.id == machine.id }
    }

    @Test
    fun aMachineApprovedFromItsQrShowsNoCheckCode() {
        val store = store()
        val m = approve(store, "${http.url("/").toString().trimEnd('/')}/pair?k=0123456789ABCDEF#${code.formatted()}")
        assertNull(m.check)
        // Kept across a restart: the app reads its saved state again.
        assertEquals(listOf(machine.id), disk.load().first?.scannedMachines)
    }

    @Test
    fun aMachineApprovedFromATypedCodeShowsItsCheckCode() {
        val store = store()
        val m = approve(store, code.formatted())
        assertNotNull(m.check)
    }
}

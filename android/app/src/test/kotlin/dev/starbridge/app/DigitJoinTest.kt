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
import dev.starbridge.app.protocol.JoinApprovalBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.PairingMessage
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * The phone joins by digits against a scripted server that approves as soon as the phone reveals
 * its key: the approval counts only once the phone's owner says the digits match (#355).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DigitJoinTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val joins = Joins(sodium)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private fun json(body: JsonElement, code: Int = 200) = MockResponse(code, okhttp3.Headers.headersOf("content-type", "application/json"), body.toString())

    @Test
    fun anApprovalCountsOnlyOnceTheOwnerSaysTheDigitsMatch() {
        val account = "acct"
        val signKeys = sodium.signKeyPair()
        val other = Member("phone", "device", "Phone", toB64(sodium.boxKeyPair().public), toB64(signKeys.public))
        val entries = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry(account, other, signKeys.secret, sodium.signKeyPair(), "2026-10-06T12:00:00Z")))
        val approverEph = sodium.boxKeyPair()

        var id = ""
        var request = ""
        var commitment = ""
        var joinerKey: String? = null
        var approval: PairingMessage? = null
        var approvedPolls = 0
        fun view() = buildJsonObject {
            put("id", id)
            put("request", request)
            put("commitment", commitment)
            put("state", if (approval != null) "approved" else "comparing")
            put("approver", "phone")
            put("approverKey", toB64(approverEph.public))
            joinerKey?.let { put("joinerKey", it) }
            approval?.let { put("approval", ProtocolJson.encodeToJsonElement(it)) }
            put("createdAt", "2026-10-06T12:00:00Z")
            put("expiresAt", "2099-01-01T00:00:00Z")
            put("version", if (approval != null) 3 else if (joinerKey != null) 2 else 1)
        }
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request_: RecordedRequest): MockResponse {
                val path = request_.url.encodedPath
                val body = request_.body?.utf8()?.takeIf { it.isNotEmpty() }?.let { ProtocolJson.parseToJsonElement(it).jsonObject }
                return when {
                    path == "/v1/joins" && request_.method == "POST" -> {
                        request = body!!.getValue("request").jsonPrimitive.content
                        commitment = body.getValue("commitment").jsonPrimitive.content
                        id = joins.openRequest(request).join
                        json(buildJsonObject { put("join", view()) })
                    }
                    path == "/v1/joins/$id/reveal" -> {
                        // The other device approves at once, before this phone's owner compared anything.
                        joinerKey = body!!.getValue("key").jsonPrimitive.content
                        val keys = joins.approverKeys(approverEph, joinerKey!!, request, commitment)
                        val dir = directories.verify(entries, account, null)
                        entries += envelopeJson(directories.addEntry(dir, "phone", signKeys.secret, joins.openRequest(request).member(), "2026-10-06T12:00:00Z"))
                        val next = directories.verify(entries, account, null)
                        approval = joins.approval(JoinApprovalBody(1, id, account, next.length, next.head, "phone"), keys)
                        json(buildJsonObject { put("join", view()) })
                    }
                    path == "/v1/joins/$id" -> {
                        if (approval != null) approvedPolls++
                        val after = request_.url.queryParameter("after")?.toLong() ?: 0
                        if (after >= view()["version"]!!.jsonPrimitive.content.toLong()) Thread.sleep(100)
                        json(buildJsonObject { put("join", view()) })
                    }
                    path == "/v1/directory" && request_.method == "GET" -> {
                        val from = request_.url.queryParameter("from")!!.toInt()
                        json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
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
        val disk = Disk(Files.createTempDirectory("starbridge").toFile(), identity)
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
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), joins, alerts, "Phone", server, false, scope)

        store.askDevices()
        until { joinerKey != null }
        val digits = joins.approverKeys(approverEph, joinerKey!!, request, commitment).digits
        assertEquals(Phase.JoiningByDigits(digits), store.phase.value)

        // The approval has been read several times; the phone still waits for its owner.
        until { approvedPolls >= 3 || disk.saved()!!.pin != null }
        assertEquals(Phase.JoiningByDigits(digits), store.phase.value)
        assertNull(disk.saved()!!.pin)

        store.confirmDigits()
        until { disk.saved()!!.pin != null }
        assertEquals(joins.openRequest(request).id, disk.saved()!!.me!!.id)
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

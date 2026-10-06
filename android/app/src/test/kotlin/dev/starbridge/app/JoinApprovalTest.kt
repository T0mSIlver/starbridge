package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Comparison
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.JoinRequestBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * The phone approves a join by digits against a scripted server whose first approval post
 * fails: the digits stay on screen, and the retry reuses the entry the first try appended.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class JoinApprovalTest {
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
    fun aFailedApprovalKeepsTheDigitsAndReusesTheEntry() {
        val account = "acct"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val genesis = directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), "2026-10-05T12:00:00Z")
        val entries = mutableListOf<JsonElement>(envelopeJson(genesis))
        val first = directories.verify(entries, account, null)

        // The browser that asks to join.
        val joiner = sodium.boxKeyPair()
        val browser = Member("w_new", "device", "New browser", toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public))
        val id = joins.newId()
        val request = joins.request(JoinRequestBody(1, id, account, browser.id, browser.name, browser.boxPk, browser.signPk, "2026-10-05T12:00:00Z"))
        fun view(version: Int, joinerKey: String? = null) = buildJsonObject {
            put("id", id)
            put("request", request)
            put("commitment", joins.commitment(joiner.public, request))
            put("state", "open")
            if (joinerKey != null) put("joinerKey", joinerKey)
            put("createdAt", "2026-10-05T12:00:00Z")
            put("expiresAt", "2099-01-01T00:00:00Z")
            put("version", version)
        }

        var approverKey: String? = null
        var appends = 0
        var approvals = 0
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                val body = request.body?.utf8()?.let { ProtocolJson.parseToJsonElement(it).jsonObject }
                return when {
                    path == "/v1/joins" -> {
                        if (approverKey != null) Thread.sleep(500)
                        json(buildJsonObject {
                            put("joins", buildJsonArray { add(view(1)) })
                            put("cursor", "1")
                        })
                    }
                    path == "/v1/joins/$id/approver" -> {
                        approverKey = body!!.getValue("key").toString().trim('"')
                        json(buildJsonObject { put("join", view(2)) })
                    }
                    path == "/v1/joins/$id" -> json(buildJsonObject { put("join", view(3, toB64(joiner.public))) })
                    path == "/v1/directory" && request.method == "GET" -> {
                        val from = request.url.queryParameter("from")!!.toInt()
                        json(buildJsonObject { put("entries", buildJsonArray { entries.drop(from).forEach { add(it) } }) })
                    }
                    path == "/v1/directory" -> {
                        appends++
                        entries += body!!.getValue("entry")
                        val dir = directories.verify(entries, account, null)
                        json(buildJsonObject { put("length", dir.length); put("head", dir.head) }, 201)
                    }
                    path == "/v1/joins/$id/approve" -> {
                        approvals++
                        if (approvals == 1) json(buildJsonObject { put("error", "internal") }, 500)
                        else json(buildJsonObject { put("approved", true) })
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
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(first.length, first.head), entries = entries.toList()))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), joins, alerts, "Phone", server, false, scope)

        store.watchJoins(true)
        until { store.joinAsks.value.isNotEmpty() }
        store.compareJoin(id)
        until { store.comparison.value is Comparison.Digits }
        val digits = joins.joinerKeys(joiner, approverKey!!, request).digits
        assertEquals(digits, (store.comparison.value as Comparison.Digits).digits)

        store.approveJoin()
        until { (store.comparison.value as? Comparison.Digits)?.error != null }
        val kept = store.comparison.value as Comparison.Digits
        assertEquals(digits, kept.digits)
        assertEquals(false, kept.approving)

        store.approveJoin()
        until { store.comparison.value is Comparison.Done }
        assertEquals(1, appends)
        assertEquals(2, approvals)
        assertNotNull(directories.verify(entries, account, null).members[browser.id])
    }

    private fun until(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!pred()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(10)
        }
    }
}

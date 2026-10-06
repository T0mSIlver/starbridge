package dev.starbridge.app.data

import dev.starbridge.app.BuildConfig
import dev.starbridge.app.protocol.PairingMessage
import dev.starbridge.app.protocol.ProtocolException
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.SignedEnvelope
import dev.starbridge.app.protocol.envelopeJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.ConnectException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import java.util.concurrent.TimeUnit

/** A refusal from the server: its status and `{error, detail}` (PROTOCOL.md, "HTTP API"). */
class ApiException(val status: Int, val error: String, detail: String?) : IOException(detail?.let { "$error: $it" } ?: "$error ($status)")

@Serializable
data class Me(val account: String, val member: String?, val role: String)

@Serializable
data class Listed(val item: SealedItem, val cursor: String, val receivedAt: String, val answeredAt: String? = null)

@Serializable
data class ItemPage(val items: List<Listed>, val cursor: String = "")

@Serializable
data class Appended(val length: Int, val head: String)

class PairingResult(val approval: JsonElement)

/** A join request as the server relays it (PROTOCOL.md, "Joining by digits"). */
@Serializable
data class JoinView(
    val id: String,
    val request: String,
    val commitment: String,
    /** "open", "comparing", "approved" or "cancelled". */
    val state: String,
    val approver: String? = null,
    val approverKey: String? = null,
    val joinerKey: String? = null,
    val approval: JsonElement? = null,
    val createdAt: String,
    val expiresAt: String,
    val version: Long,
)

@Serializable
data class JoinList(val joins: List<JoinView>, val cursor: String)

/**
 * A deploy restarts the server in a few seconds (#150), so a 502 or 503 from Caddy, or a refused
 * connection, is retried quietly for this long before the caller hears of it (#250).
 */
const val RETRY_FOR_MS = 20_000L

/** The server's routes this client uses, as PROTOCOL.md lists them. */
class Api(private val http: OkHttpClient, private val server: String, private val session: String?) {
    private val json = "application/json".toMediaType()

    private suspend fun call(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap(), client: OkHttpClient = http): Pair<Int, JsonElement?> {
        val started = System.currentTimeMillis()
        var wait = 250L
        while (true) {
            try {
                return once(method, path, body, headers, client)
            } catch (e: IOException) {
                val transient = when (e) {
                    is ApiException -> e.status == 502 || e.status == 503
                    // Refused: the request never left. Any other failure may have reached the
                    // server, so only a read, which is safe to repeat, retries on it.
                    is ConnectException -> true
                    else -> method == "GET"
                }
                if (!transient || System.currentTimeMillis() - started + wait > RETRY_FOR_MS) throw e
            }
            delay(wait)
            wait = (wait * 2).coerceAtMost(4_000)
        }
    }

    private suspend fun once(method: String, path: String, body: JsonElement?, headers: Map<String, String>, client: OkHttpClient): Pair<Int, JsonElement?> =
        run {
            val request = Request.Builder()
                .url("$server/v1$path")
                // OkHttp refuses a POST without a body; a bodiless ask sends an empty one (#253).
                .method(method, body?.toString()?.toRequestBody(json) ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody())
                .apply {
                    header("starbridge-client", "android/${BuildConfig.VERSION_NAME}")
                    session?.let { header("Authorization", "Bearer $it") }
                    headers.forEach { (k, v) -> header(k, v) }
                }
                .build()
            val (code, text) = client.newCall(request).await()
            val parsed = text.takeIf { it.isNotBlank() }?.let { runCatching { ProtocolJson.parseToJsonElement(it) }.getOrNull() }
            if (code !in 200..299) {
                val o = parsed as? JsonObject
                val error = o?.get("error")?.jsonPrimitive?.content ?: "http-$code"
                // The server no longer serves this release (PROTOCOL.md, "HTTP API").
                if (code == 426) throw ApiException(code, error, "update Starbridge from Google Play: this server needs ${o?.get("minimum")?.jsonPrimitive?.content ?: "a newer release"} or later")
                throw ApiException(code, error, o?.get("detail")?.jsonPrimitive?.content)
            }
            code to parsed
        }

    /** Runs the call on OkHttp's threads; cancelling the coroutine cancels the call, body read included. */
    private suspend fun Call.await(): Pair<Int, String> = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)

            override fun onResponse(call: Call, response: Response) {
                val result = runCatching { response.use { it.code to it.body.string() } }
                result.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }
        })
    }

    private suspend inline fun <reified T> get(path: String): T = ProtocolJson.decodeFromJsonElement(call("GET", path).second!!)

    /** Self-hosted sign-in with the server's OWNER_TOKEN; returns the session token. */
    suspend fun ownerSignIn(token: String): String =
        call("POST", "/auth/owner", buildJsonObject { put("token", token) }).second!!.jsonObject.getValue("session").jsonPrimitive.content

    /** Trades the sign-in redirect's one-time code and the PKCE verifier for a session. */
    suspend fun appSession(code: String, verifier: String): String =
        call("POST", "/auth/app/session", buildJsonObject { put("code", code); put("verifier", verifier) }).second!!.jsonObject.getValue("session").jsonPrimitive.content

    /** Trades GitHub's code from a redirect this app caught, its state and the PKCE verifier for a session. */
    suspend fun appGitHubSession(code: String, state: String, verifier: String): String =
        call("POST", "/auth/app/github", buildJsonObject { put("code", code); put("state", state); put("verifier", verifier) }).second!!.jsonObject.getValue("session").jsonPrimitive.content

    /** A single-use nonce to sign for [bind]. */
    suspend fun challenge(): String = call("GET", "/auth/challenge").second!!.jsonObject.getValue("nonce").jsonPrimitive.content

    /** Binds this session to an existing device that signed the challenge with its key. */
    suspend fun bind(member: String, sig: String) {
        call("POST", "/auth/bind", buildJsonObject { put("member", member); put("sig", sig) })
    }

    suspend fun logout() {
        call("POST", "/auth/logout")
    }

    suspend fun me(): Me = get("/me")

    suspend fun directory(from: Int): List<JsonElement> =
        call("GET", "/directory?from=$from").second!!.jsonObject.getValue("entries").let { ProtocolJson.decodeFromJsonElement(it) }

    suspend fun append(entry: SignedEnvelope): Appended =
        ProtocolJson.decodeFromJsonElement(call("POST", "/directory", buildJsonObject { put("entry", envelopeJson(entry)) }).second!!)

    suspend fun postPairing(request: PairingMessage, claimHash: String) {
        call("POST", "/pairings", buildJsonObject {
            put("request", ProtocolJson.encodeToJsonElement(request))
            put("claimHash", claimHash)
        })
    }

    suspend fun pairing(rendezvous: String): JsonElement = call("GET", "/pairings/$rendezvous").second!!.jsonObject.getValue("request")

    suspend fun approve(rendezvous: String, approval: PairingMessage) {
        call("POST", "/pairings/$rendezvous/approve", buildJsonObject { put("approval", ProtocolJson.encodeToJsonElement(approval)) })
    }

    /** Long-polls for this new device's approval; null when [waitSeconds] pass first. */
    suspend fun pairingResult(rendezvous: String, claim: String, waitSeconds: Int): PairingResult? {
        val longPoll = http.newBuilder().readTimeout((waitSeconds + 15).toLong(), TimeUnit.SECONDS).build()
        val (status, body) = call("GET", "/pairings/$rendezvous/result?wait=$waitSeconds", headers = mapOf("X-Claim" to claim), client = longPoll)
        if (status == 204 || body == null) return null
        // A reply without one is the server's fault, never the end of the app (#274).
        val approval = (body as? JsonObject)?.get("approval") ?: throw ProtocolException("malformed", "pairing result without an approval")
        return PairingResult(approval)
    }

    private fun longPoll(waitSeconds: Int) = http.newBuilder().readTimeout((waitSeconds + 15).toLong(), TimeUnit.SECONDS).build()

    /** Holds until a new member posts under [rendezvous]; null when [waitSeconds] pass first. */
    suspend fun awaitPairing(rendezvous: String, waitSeconds: Int): JsonElement? {
        val (status, body) = call("GET", "/pairings/$rendezvous?wait=$waitSeconds", client = longPoll(waitSeconds))
        if (status == 204 || body == null) return null
        return body.jsonObject.getValue("request")
    }

    private fun join(body: JsonElement?): JoinView = ProtocolJson.decodeFromJsonElement(body!!.jsonObject.getValue("join"))

    suspend fun postJoin(request: String, commitment: String): JoinView =
        join(call("POST", "/joins", buildJsonObject { put("request", request); put("commitment", commitment) }).second)

    /** Open join requests; with [waitSeconds], holds until one changes past [after]. */
    suspend fun joins(after: String, waitSeconds: Int): JoinList =
        ProtocolJson.decodeFromJsonElement(call("GET", "/joins?after=$after&wait=$waitSeconds", client = longPoll(waitSeconds)).second!!)

    suspend fun join(id: String, after: Long, waitSeconds: Int): JoinView =
        join(call("GET", "/joins/$id?after=$after&wait=$waitSeconds", client = longPoll(waitSeconds)).second)

    suspend fun claimJoin(id: String, key: String, approver: String): JoinView =
        join(call("POST", "/joins/$id/approver", buildJsonObject { put("key", key); put("approver", approver) }).second)

    suspend fun revealJoin(id: String, key: String): JoinView =
        join(call("POST", "/joins/$id/reveal", buildJsonObject { put("key", key) }).second)

    suspend fun approveJoin(id: String, approval: PairingMessage) {
        call("POST", "/joins/$id/approve", buildJsonObject { put("approval", ProtocolJson.encodeToJsonElement(approval)) })
    }

    suspend fun cancelJoin(id: String) {
        call("DELETE", "/joins/$id")
    }

    suspend fun postItem(item: SealedItem) {
        call("POST", "/items", ProtocolJson.encodeToJsonElement(item))
    }

    suspend fun items(kind: String, after: String): ItemPage = get("/items?kind=$kind&after=$after")

    suspend fun item(id: String): Listed = get("/items/$id")

    /** Asks every machine for a fresh quota snapshot; returns once they posted or [waitSeconds] pass. */
    suspend fun askQuota(waitSeconds: Int) {
        call("POST", "/quota/ask?wait=$waitSeconds", client = longPoll(waitSeconds))
    }

    suspend fun quota(): List<Listed> = call("GET", "/quota").second!!.jsonObject.getValue("items").let { ProtocolJson.decodeFromJsonElement(it) }

    /** Returns the subscription id. [keys] carries RFC 8291's p256dh and auth for UnifiedPush. */
    suspend fun subscribe(type: String, endpoint: String, keys: Pair<String, String>? = null): String =
        call("POST", "/push/subscriptions", buildJsonObject {
            put("type", type)
            put("endpoint", endpoint)
            keys?.let { (p256dh, auth) -> put("keys", buildJsonObject { put("p256dh", p256dh); put("auth", auth) }) }
        }).second!!.jsonObject.getValue("id").jsonPrimitive.content

    suspend fun unsubscribe(id: String) {
        call("DELETE", "/push/subscriptions/$id")
    }
}

package dev.starbridge.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// packages/protocol/src/join.ts. Joining by digits: the joining device commits to an ephemeral
// X25519 key, the approver reveals its own, then the joiner reveals; both derive a MAC key and 6
// digits from the shared secret and the transcript, and the owner compares the digits.

@Serializable
data class JoinRequestBody(
    val v: Int,
    val join: String,
    val account: String,
    val id: String,
    val name: String,
    val boxPk: String,
    val signPk: String,
    val at: String,
) {
    fun check() {
        schema(v == 1, "v")
        schema(Regex("^[0-9A-HJKMNP-TV-Z]{8}$").matches(join), "join")
        id(account, "account")
        id(id, "id")
        len(name, 1, 100, "name")
        b64(boxPk, "boxPk")
        b64(signPk, "signPk")
        time(at, "at")
    }

    fun member() = Member(id, "device", name, boxPk, signPk)
}

@Serializable
data class JoinApprovalBody(
    val v: Int,
    val join: String,
    val account: String,
    /** The directory up to and including the new device's entry. */
    val length: Int,
    val head: String,
    val approver: String,
) {
    fun check() {
        schema(v == 1, "v")
        schema(join.length == 8, "join")
        id(account, "account")
        schema(length > 0, "length")
        b64(head, "head")
        id(approver, "approver")
    }
}

/** What a join derives once both ephemeral keys are known. */
class JoinKeys(val mac: ByteArray, val digits: String)

class Joins(private val sodium: Sodium) {
    fun newId(): String = encodeCrockford(sodium.random(5))

    /** A fresh X25519 key pair for one join; never reused. */
    fun newKeyPair(): KeyPair = sodium.boxKeyPair()

    /** The request text the joining device posts: JSON of the checked body, in field order. */
    fun request(body: JoinRequestBody): String {
        body.check()
        return buildJsonObject {
            put("v", body.v)
            put("join", body.join)
            put("account", body.account)
            put("id", body.id)
            put("name", body.name)
            put("boxPk", body.boxPk)
            put("signPk", body.signPk)
            put("at", body.at)
        }.toString()
    }

    fun openRequest(request: String): JoinRequestBody =
        parseJson(JoinRequestBody.serializer(), parseJsonText(request)).also { it.check() }

    private fun label(name: String) = concat(utf8("starbridge/v1/$name"), byteArrayOf(0))

    /** BLAKE2b-256 of "starbridge/v1/join-commit", NUL, the joiner's key, the request text. */
    fun commitment(joinerKey: ByteArray, request: String): String = toB64(sodium.hash(concat(label("join-commit"), joinerKey, utf8(request))))

    private fun key32(b64: String, what: String): ByteArray {
        val k = fromB64(b64)
        if (k.size != 32) throw ProtocolException("bad-encoding", "$what is not 32 bytes")
        return k
    }

    private fun derive(mine: KeyPair, peer: ByteArray, joinerKey: ByteArray, approverKey: ByteArray, request: String): JoinKeys {
        val shared = sodium.scalarMult(mine.secret, peer) ?: throw ProtocolException("bad-key", "the other side's key is not usable")
        if (shared.all { it == 0.toByte() }) throw ProtocolException("bad-key", "all-zero shared secret")
        val transcript = concat(joinerKey, approverKey, utf8(request))
        val mac = sodium.keyedHash(concat(label("join-mac"), transcript), shared)
        val sas = sodium.keyedHash(concat(label("join-sas"), transcript), shared)
        shared.fill(0)
        val n = ((sas[0].toLong() and 0xff) shl 24) or ((sas[1].toLong() and 0xff) shl 16) or ((sas[2].toLong() and 0xff) shl 8) or (sas[3].toLong() and 0xff)
        return JoinKeys(mac, (n % 1_000_000).toString().padStart(6, '0'))
    }

    /** The joining device, once the approver's key arrived; it reveals its own key only after. */
    fun joinerKeys(mine: KeyPair, approverKey: String, request: String): JoinKeys {
        val approver = key32(approverKey, "approver key")
        return derive(mine, approver, mine.public, approver, request)
    }

    /** The approving device, once the joiner revealed its key: it must open the commitment. */
    fun approverKeys(mine: KeyPair, joinerKey: String, request: String, commitment: String): JoinKeys {
        val joiner = key32(joinerKey, "joiner key")
        if (commitment(joiner, request) != commitment) throw ProtocolException("bad-commitment", "the revealed key does not match the commitment")
        return derive(mine, joiner, joiner, mine.public, request)
    }

    private fun macMessage(body: String) = concat(label("join-approval"), utf8(body))

    /** Made by the approver once the new device's entry is in the directory. */
    fun approval(body: JoinApprovalBody, keys: JoinKeys): PairingMessage {
        body.check()
        val text = buildJsonObject {
            put("v", body.v)
            put("join", body.join)
            put("account", body.account)
            put("length", body.length)
            put("head", body.head)
            put("approver", body.approver)
        }.toString()
        return PairingMessage(text, toB64(sodium.auth(macMessage(text), keys.mac)))
    }

    /** Checked by the joining device; it then verifies the directory with `{length, head}` as pin. */
    fun openApproval(msg: JsonElement, keys: JoinKeys, join: String): JoinApprovalBody {
        val m = parseJson(PairingMessage.serializer(), msg)
        b64(m.mac, "mac")
        val ok = try {
            sodium.authVerify(fromB64(m.mac), macMessage(m.body), keys.mac)
        } catch (e: ProtocolException) {
            false
        }
        if (!ok) throw ProtocolException("bad-mac", "join-approval")
        val body = parseJson(JoinApprovalBody.serializer(), parseJsonText(m.body)).also { it.check() }
        if (body.join != join) throw ProtocolException("id-mismatch", "join")
        return body
    }
}

/** "123 456": the digits as both screens show them. */
fun formatDigits(digits: String) = "${digits.take(3)} ${digits.drop(3)}"

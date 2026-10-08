package dev.starbridge.app.protocol

import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// packages/protocol/src/pairing.ts. The new member shows a 24-character code: 8 characters of
// rendezvous id, which the server sees, and 16 characters (80 bits) of secret, which never
// reaches it and keys an HMAC on both pairing messages.

internal const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

data class PairingCode(val rendezvous: String, val secret: String) {
    /** "ABCD-EFGH-…", six groups of four. */
    fun formatted(): String = (rendezvous + secret).chunked(4).joinToString("-")
}

fun encodeCrockford(bytes: ByteArray): String {
    var bits = 0
    var value = 0
    val out = StringBuilder()
    for (b in bytes) {
        value = (value shl 8) or (b.toInt() and 0xff)
        bits += 8
        while (bits >= 5) {
            out.append(CROCKFORD[(value ushr (bits - 5)) and 31])
            bits -= 5
        }
        value = value and ((1 shl bits) - 1)
    }
    if (bits > 0) out.append(CROCKFORD[(value shl (5 - bits)) and 31])
    return out.toString()
}

private fun splitCode(chars: String) = PairingCode(chars.substring(0, 8), chars.substring(8, 24))

/** Accepts any case, dashes and spaces, and Crockford's look-alikes (O for 0, I and L for 1). */
fun parsePairingCode(text: String): PairingCode {
    val chars = text.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace(Regex("[IL]"), "1")
    if (chars.length != 24 || chars.any { it !in CROCKFORD }) throw ProtocolException("bad-encoding", "pairing code must be 24 Crockford base32 characters")
    return splitCode(chars)
}

/**
 * The link a QR code carries: `<server>/pair#<code>`. Opened in a browser, it shows the web page
 * with the code filled in; the fragment never reaches the server.
 */
fun pairingLink(server: String, code: PairingCode): String = "${server.trimEnd('/')}/pair#${code.formatted()}"

/** A code typed by hand, or read from a scanned pairing link: the part after `#` if any. */
fun codeFromLink(text: String): PairingCode = parsePairingCode(text.substringAfter('#'))

/** The check key a machine's QR carries in its query (`k=`, before any `#`), or null (#795). */
fun checkKeyFromLink(text: String): String? {
    val head = text.substringBefore('#')
    if ('?' !in head) return null
    val key = head.substringAfter('?').split('&').firstOrNull { it.startsWith("k=") }?.substring(2)?.uppercase() ?: return null
    return key.takeIf { it.length == 16 && it.all { c -> c in CROCKFORD } }
}

/**
 * The host of a pairing link made on a server other than [server], or null for a bare code or a
 * link to [server] (#671). Asked only once the lookup failed: a server can answer on several
 * names, and a link under another of them still pairs.
 */
fun otherServer(text: String, server: String): String? {
    var link = runCatching { URI(text.trim()) }.getOrNull() ?: return null
    // A machine's QR code names its server in the query (#795).
    if (link.scheme == "starbridge") {
        val named = link.rawQuery?.split('&')?.firstOrNull { it.startsWith("server=") }?.substring(7) ?: return null
        link = runCatching { URI(URLDecoder.decode(named, "UTF-8")) }.getOrNull() ?: return null
    }
    if (link.scheme != "https" && link.scheme != "http" || link.host == null) return null
    val own = runCatching { URI(server.trim()) }.getOrNull()
    return if (own != null && hostPort(own) == hostPort(link)) null else link.rawAuthority
}

private fun hostPort(uri: URI) = uri.host?.lowercase() to if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80

@Serializable
data class PairingMessage(val body: String, val mac: String)

@Serializable
data class PairingRequestBody(
    val v: Int,
    val rendezvous: String,
    val role: String,
    val id: String,
    val name: String,
    val boxPk: String,
    val signPk: String,
    val at: String,
) {
    fun check() {
        schema(v == 1, "v")
        schema(rendezvous.length == 8, "rendezvous")
        schema(role == "device" || role == "machine", "role")
        id(id, "id")
        len(name, 1, 100, "name")
        b64(boxPk, "boxPk")
        b64(signPk, "signPk")
        time(at, "at")
    }

    fun member() = Member(id, role, name, boxPk, signPk)
}

@Serializable
data class PairingApprovalBody(
    val v: Int,
    val rendezvous: String,
    val account: String,
    /** The directory up to and including the new member's entry. */
    val length: Int,
    val head: String,
    val approver: String,
    /** [Pairings.checkProof] of the new machine's `add` entry, when the approver scanned its QR. */
    val check: String? = null,
) {
    fun check() {
        schema(v == 1, "v")
        schema(rendezvous.length == 8, "rendezvous")
        id(account, "account")
        schema(length > 0, "length")
        b64(head, "head")
        id(approver, "approver")
        check?.let { b64(it, "check") }
    }
}

class Pairings(private val sodium: Sodium) {
    fun newCode(): PairingCode = splitCode(encodeCrockford(sodium.random(15)))

    /** Sent as `X-Claim` to fetch the result; the server keeps only [claimHash] of it. */
    fun newClaimSecret(): String = toB64(sodium.random(32))

    fun claimHash(secret: String): String = toB64(sodium.hash(utf8(secret)))

    /** The bytes a check code hashes: "starbridge/v1/check" NUL body NUL sig of member [id]'s `add` entry. */
    private fun checkInput(entries: List<JsonElement>, id: String): ByteArray {
        for (raw in entries) {
            val env = raw as? JsonObject ?: continue
            val body = (env["body"] as? JsonPrimitive)?.contentOrNull ?: continue
            val sig = (env["sig"] as? JsonPrimitive)?.contentOrNull ?: continue
            val parsed = ProtocolJson.parseToJsonElement(body) as? JsonObject ?: continue
            if ((parsed["op"] as? JsonPrimitive)?.contentOrNull != "add") continue
            if (((parsed["member"] as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull != id) continue
            val nul = byteArrayOf(0)
            return concat(utf8("starbridge/v1/check"), nul, utf8(body), nul, utf8(sig))
        }
        throw ProtocolException("unknown-member", "no add entry for $id")
    }

    /**
     * A machine's check code (#795), which its owner compares with the machine's when the app did
     * not scan its QR: the first 80 bits of BLAKE2b-256 of the `add` entry that added member [id],
     * as 16 Crockford base32 characters in groups of four.
     */
    fun checkCode(entries: List<JsonElement>, id: String): String =
        encodeCrockford(sodium.hash(checkInput(entries, id)).copyOf(10)).chunked(4).joinToString("-")

    /**
     * The approval's `check` for a machine whose QR gave [key]: `crypto_auth` of the same bytes
     * under BLAKE2b-256("starbridge/v1/check-key" NUL key). The machine verifies it over its own
     * `add` entry, so it saves the pairing without asking the owner.
     */
    fun checkProof(entries: List<JsonElement>, id: String, key: String): String =
        toB64(sodium.auth(checkInput(entries, id), sodium.hash(concat(utf8("starbridge/v1/check-key"), byteArrayOf(0), utf8(key)))))

    /** BLAKE2b-256 of "starbridge/v1/pairing-key", NUL, the 16 secret characters. */
    fun key(code: PairingCode): ByteArray = sodium.hash(concat(utf8("starbridge/v1/pairing-key"), byteArrayOf(0), utf8(code.secret)))

    private fun macMessage(kind: String, body: String) = concat(utf8("starbridge/v1/$kind"), byteArrayOf(0), utf8(body))

    private fun authenticate(kind: String, body: JsonObject, code: PairingCode): PairingMessage {
        val text = body.toString()
        return PairingMessage(text, toB64(sodium.auth(macMessage(kind, text), key(code))))
    }

    private fun check(kind: String, msg: JsonElement, code: PairingCode): JsonElement {
        val m = parseJson(PairingMessage.serializer(), msg)
        b64(m.mac, "mac")
        val ok = try {
            sodium.authVerify(fromB64(m.mac), macMessage(kind, m.body), key(code))
        } catch (e: ProtocolException) {
            false
        }
        if (!ok) throw ProtocolException("bad-mac", kind)
        return parseJsonText(m.body)
    }

    /** Made by a new member (this phone joining an account) and posted under the rendezvous id. */
    fun request(body: PairingRequestBody, code: PairingCode): PairingMessage {
        require(body.rendezvous == code.rendezvous) { "rendezvous differs from the code" }
        body.check()
        return authenticate("pairing-request", buildJsonObject {
            put("v", body.v)
            put("rendezvous", body.rendezvous)
            put("role", body.role)
            put("id", body.id)
            put("name", body.name)
            put("boxPk", body.boxPk)
            put("signPk", body.signPk)
            put("at", body.at)
        }, code)
    }

    /** Checked by the approving device after the owner types the code. */
    fun openRequest(msg: JsonElement, code: PairingCode): PairingRequestBody {
        val body = parseJson(PairingRequestBody.serializer(), check("pairing-request", msg, code)).also { it.check() }
        if (body.rendezvous != code.rendezvous) throw ProtocolException("id-mismatch", "rendezvous")
        return body
    }

    /** Made by the approving device once the new member's entry is in the directory. */
    fun approval(body: PairingApprovalBody, code: PairingCode): PairingMessage {
        body.check()
        return authenticate("pairing-approval", buildJsonObject {
            put("v", body.v)
            put("rendezvous", body.rendezvous)
            put("account", body.account)
            put("length", body.length)
            put("head", body.head)
            put("approver", body.approver)
            body.check?.let { put("check", it) }
        }, code)
    }

    /** Checked by the new member; it then verifies the directory with `{length, head}` as pin. */
    fun openApproval(msg: JsonElement, code: PairingCode): PairingApprovalBody {
        val body = parseJson(PairingApprovalBody.serializer(), check("pairing-approval", msg, code)).also { it.check() }
        if (body.rendezvous != code.rendezvous) throw ProtocolException("id-mismatch", "rendezvous")
        return body
    }
}

/** After pairing: the verified directory must hold the new member, active, with its own keys. */
fun checkJoined(dir: Directory, me: Member) {
    val entry = dir.members[me.id]
    if (entry == null || !entry.active || entry.member.role != me.role || entry.member.boxPk != me.boxPk || entry.member.signPk != me.signPk) {
        throw ProtocolException("unknown-member", "the directory does not hold my keys")
    }
}

/**
 * What a device signs to bind a fresh session to itself after signing in again:
 * "starbridge/v1/bind", NUL, account, NUL, member id, NUL, the server's single-use nonce.
 */
fun bindMessage(account: String, member: String, nonce: String): ByteArray =
    concat(utf8("starbridge/v1/bind"), byteArrayOf(0), utf8(account), byteArrayOf(0), utf8(member), byteArrayOf(0), utf8(nonce))

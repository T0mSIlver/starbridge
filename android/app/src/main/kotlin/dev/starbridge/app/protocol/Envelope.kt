package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// packages/protocol/src/envelope.ts: sign, then seal; open, then verify, then parse.

/** "starbridge/v1/<kind>", NUL, signer id, NUL, body. */
fun signatureMessage(kind: String, signer: String, body: String): ByteArray =
    concat(utf8("starbridge/v1/$kind"), byteArrayOf(0), utf8(signer), byteArrayOf(0), utf8(body))

fun envelopeJson(env: SignedEnvelope): JsonObject = buildJsonObject {
    put("v", env.v)
    put("kind", env.kind)
    put("signer", env.signer)
    put("body", env.body)
    put("sig", env.sig)
    env.recoverySig?.let { put("recoverySig", it) }
}

class Opened<T>(val signer: Member, val body: T, val bodyText: String)

class Envelopes(private val sodium: Sodium) {
    /** Signs [body], JSON text kept exactly as it will be sent. */
    fun sign(kind: String, body: JsonObject, signer: String, signKey: ByteArray): SignedEnvelope {
        val text = body.toString()
        val sig = sodium.sign(signatureMessage(kind, signer, text), signKey)
        return SignedEnvelope(1, kind, signer, text, toB64(sig))
    }

    /** Throws `bad-signature` unless [signPk] signed this envelope. */
    fun verify(env: SignedEnvelope, signPk: String) {
        val ok = try {
            sodium.verify(fromB64(env.sig), signatureMessage(env.kind, env.signer, env.body), fromB64(signPk))
        } catch (e: ProtocolException) {
            false
        }
        if (!ok) throw ProtocolException("bad-signature", "signer ${env.signer}")
    }

    /**
     * Signs [body] and seals the envelope to each recipient. The body must parse as [kind] and
     * its `to` must name exactly the recipients; the item's id and `re` come from the body.
     */
    fun seal(kind: String, body: JsonObject, signer: String, signKey: ByteArray, recipients: List<Member>): SealedItem {
        val parsed = parseBody(kind, body.toString()) as? ItemBody
            ?: throw IllegalArgumentException("$kind is not an item kind")
        val named = parsed.recipients
        val ids = recipients.map { it.id }
        require(named.size == ids.size && named.toSet() == ids.toSet()) { "body.to must list exactly the recipients" }
        val plain = utf8(envelopeJson(sign(kind, body, signer, signKey)).toString())
        return SealedItem(
            v = 1,
            kind = kind,
            id = parsed.id,
            from = signer,
            re = parsed.re,
            boxes = recipients.map { SealedBox(it.id, toB64(sodium.seal(plain, fromB64(it.boxPk)))) },
        )
    }

    /** Opens this member's box. The envelope inside is not verified yet. */
    fun openBox(item: SealedItem, me: String, box: KeyPair): SignedEnvelope {
        val mine = item.boxes.find { it.to == me } ?: throw ProtocolException("wrong-recipient", "no box for $me")
        val plain = sodium.sealOpen(fromB64(mine.box), box) ?: throw ProtocolException("cannot-open")
        val text = try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(plain)).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            throw ProtocolException("bad-schema", "sealed content is not UTF-8")
        }
        val env = parseJson(SignedEnvelope.serializer(), parseJsonText(text)).also { it.check() }
        if (env.kind != item.kind) throw ProtocolException("wrong-kind", "${env.kind} in ${item.kind}")
        return env
    }

    /**
     * Opens, verifies and parses an item for [me]. The signer must be an active member of the
     * verified directory with the role allowed for this kind, and the signed body must match the
     * item's id and name [me] as a recipient.
     */
    fun open(item: SealedItem, me: String, box: KeyPair, directory: Directory): Opened<Any> {
        item.check()
        val env = openBox(item, me, box)
        if (env.signer != item.from) throw ProtocolException("id-mismatch", "from is not the signer")
        val entry = directory.members[env.signer] ?: throw ProtocolException("unknown-signer", env.signer)
        if (!entry.active) throw ProtocolException("revoked-signer", env.signer)
        if (entry.member.role != SIGNER_ROLE[item.kind]) throw ProtocolException("signer-not-allowed", "${entry.member.role} cannot sign ${item.kind}")
        verify(env, entry.member.signPk)
        val body = parseBody(item.kind, env.body) as ItemBody
        if (body.id != item.id) throw ProtocolException("id-mismatch", "body id is not the item id")
        if (item.re != body.re) throw ProtocolException("id-mismatch", "re is not the item the body refers to")
        if (me !in body.recipients) throw ProtocolException("wrong-recipient", "body does not name me")
        return Opened(entry.member, body, env.body)
    }
}

/**
 * Parses a body whose signature was already checked. A value it only displays and does not know
 * reads as the neutral case first, as in schemas.ts.
 */
fun parseBody(kind: String, text: String): Any {
    val json = parseJsonText(text)
    return when (kind) {
        "directory" -> parseJson(DirectoryEntry.serializer(), json).also { it.check() }
        "decision" -> parseJson(Decision.serializer(), json).read().also { it.check() }
        "answer" -> parseJson(Answer.serializer(), json).also { it.check() }
        "quota" -> parseJson(QuotaSnapshot.serializer(), json).read().also { it.check() }
        "permission" -> parseJson(Permission.serializer(), json).read().also { it.check() }
        "permission-answer" -> parseJson(PermissionAnswer.serializer(), json).also { it.check() }
        "settled" -> parseJson(Settled.serializer(), json).read().also { it.check() }
        "waiting" -> parseJson(Waiting.serializer(), json).read().also { it.check() }
        "run" -> parseJson(Run.serializer(), json).read().also { it.check() }
        else -> throw ProtocolException("wrong-kind", kind)
    }
}

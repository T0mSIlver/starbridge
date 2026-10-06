package dev.starbridge.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// packages/protocol/src/directory.ts: the account's hash chain of signed entries.

class DirectoryMember(val member: Member, val active: Boolean)

/** The account's members after replaying a verified chain. */
/** A recovery key's proposal ([seq] of the entry), or the entry that made it current. */
class RecoveryChange(val seq: Int, val recoveryPk: String, val by: String, val at: String)

class Directory(
    val account: String,
    /** The current recovery key: entry 0's, or the last confirmed replacement's. */
    val recoveryPk: String,
    /** In the order the chain added them. */
    val members: LinkedHashMap<String, DirectoryMember>,
    val length: Int,
    /** Hash of the last entry's body; the next entry's `prev`. */
    val head: String,
    /** The entry that made [recoveryPk] current, the device that proposed it, and when. */
    val recoverySet: RecoveryChange,
    /** A proposed recovery key no confirmation has made current yet. */
    val pendingRecovery: RecoveryChange? = null,
    /** Every recovery key the chain named or proposed, retired ones too: none is used again. */
    val recoveryPks: Set<String> = setOf(recoveryPk),
) {
    fun active(role: String): List<Member> = members.values.filter { it.active && it.member.role == role }.map { it.member }
}

/** What a client remembers between fetches, so the server cannot roll the chain back. */
@Serializable
data class Pin(val length: Int, val head: String)

class Directories(private val sodium: Sodium, private val envelopes: Envelopes) {
    /** BLAKE2b-256 of an entry's body text. */
    fun entryHash(body: String): String = toB64(sodium.hash(utf8(body)))

    /**
     * Replays the chain and checks every rule packages/protocol checks: a self-signed genesis
     * co-signed by the recovery key it names; each later entry signed by an active device or the
     * recovery key, with the next `seq` and the previous hash; machines sign nothing, the
     * recovery key adds only devices; keys and ids are never reused, revoked members stay revoked.
     */
    fun verify(entries: List<JsonElement>, account: String? = null, pin: Pin? = null, recoveryPk: String? = null): Directory {
        if (entries.isEmpty()) throw ProtocolException("bad-genesis", "empty chain")
        var dir: Directory? = null
        val envs = entries.mapIndexed { i, raw ->
            val env = parseJson(SignedEnvelope.serializer(), raw).also { it.check() }
            if (env.kind != "directory") throw ProtocolException("wrong-kind", "entry $i")
            dir = dir?.let { apply(it, env, i) } ?: genesis(env, account)
            env
        }
        val result = dir!!
        if (recoveryPk != null && result.recoveryPk != recoveryPk) throw ProtocolException("wrong-recovery-key", "recovery key differs")
        if (pin != null) {
            if (result.length < pin.length || pin.length < 1 || entryHash(envs[pin.length - 1].body) != pin.head) {
                throw ProtocolException("rollback", "chain does not extend the pinned one")
            }
        }
        return result
    }

    private fun genesis(env: SignedEnvelope, account: String?): Directory {
        // The first entry carries its own key, so it is parsed before its signature is checked;
        // nothing in it is trusted until the check passes.
        val body = parseBody("directory", env.body) as DirectoryEntry
        if (body.op != "add" || body.seq != 0 || body.prev != null) throw ProtocolException("bad-genesis", "must be seq 0, prev null, op add")
        val member = body.member!!
        if (member.role != "device") throw ProtocolException("bad-genesis", "must add a device")
        if (env.signer != member.id) throw ProtocolException("bad-genesis", "must be self-signed")
        if (member.id == RECOVERY) throw ProtocolException("duplicate-member", RECOVERY)
        val named = body.recoveryPk ?: throw ProtocolException("bad-genesis", "missing recoveryPk")
        envelopes.verify(env, member.signPk)
        val recoverySig = env.recoverySig ?: throw ProtocolException("bad-genesis", "missing recoverySig")
        envelopes.verify(env.copy(signer = RECOVERY, sig = recoverySig), named)
        if (account != null && body.account != account) throw ProtocolException("wrong-account", body.account)
        return Directory(
            body.account, named, linkedMapOf(member.id to DirectoryMember(member, true)), 1, entryHash(env.body),
            recoverySet = RecoveryChange(0, named, member.id, body.at),
        )
    }

    private fun apply(dir: Directory, env: SignedEnvelope, i: Int): Directory {
        val signPk = if (env.signer == RECOVERY) {
            dir.recoveryPk
        } else {
            val signer = dir.members[env.signer] ?: throw ProtocolException("unknown-signer", "entry $i: ${env.signer}")
            if (!signer.active) throw ProtocolException("revoked-signer", "entry $i: ${env.signer}")
            if (signer.member.role != "device") throw ProtocolException("signer-not-allowed", "entry $i: machines sign no entries")
            signer.member.signPk
        }
        envelopes.verify(env, signPk)
        val body = parseBody("directory", env.body) as DirectoryEntry
        if (body.seq != i || body.prev != dir.head) throw ProtocolException("bad-chain", "entry $i: seq or prev")
        if (body.account != dir.account) throw ProtocolException("wrong-account", "entry $i")
        if (env.recoverySig != null && body.op != "recovery") throw ProtocolException("bad-chain", "entry $i: only entry 0 and proposals have recoverySig")

        val members = LinkedHashMap(dir.members)
        var recoveryPk = dir.recoveryPk
        var recoverySet = dir.recoverySet
        var pending = dir.pendingRecovery
        when (body.op) {
            "add" -> {
                if (body.recoveryPk != null) throw ProtocolException("bad-chain", "entry $i: only entry 0 names the recovery key")
                val m = body.member!!
                if (env.signer == RECOVERY && m.role != "device") throw ProtocolException("signer-not-allowed", "entry $i: recovery adds devices only")
                if (keyInUse(dir, m.signPk) || keyInUse(dir, m.boxPk) || members.containsKey(m.id) || m.id == RECOVERY) {
                    throw ProtocolException("duplicate-member", "entry $i: ${m.id}")
                }
                members[m.id] = DirectoryMember(m, true)
            }
            "revoke" -> {
                val target = members[body.id!!]
                if (target == null || !target.active) throw ProtocolException("unknown-member", "entry $i: ${body.id}")
                members[body.id] = DirectoryMember(target.member, false)
                // A revoked device's proposal goes with it.
                if (pending?.by == body.id) pending = null
            }
            "recovery" -> {
                if (env.signer == RECOVERY) throw ProtocolException("signer-not-allowed", "entry $i: a device proposes a recovery key")
                val sig = env.recoverySig ?: throw ProtocolException("bad-recovery", "entry $i: missing the new key's recoverySig")
                val proposed = body.recoveryPk!!
                envelopes.verify(env.copy(signer = RECOVERY, sig = sig), proposed)
                if (keyInUse(dir, proposed)) throw ProtocolException("bad-recovery", "entry $i: the key is already in use")
                pending = RecoveryChange(i, proposed, env.signer, body.at)
            }
            "recovery-confirm" -> {
                val p = pending
                if (p == null || body.proposal != p.seq) throw ProtocolException("bad-recovery", "entry $i: no pending proposal ${body.proposal}")
                if (env.signer == p.by) throw ProtocolException("signer-not-allowed", "entry $i: the proposing device cannot confirm its own proposal")
                recoveryPk = p.recoveryPk
                recoverySet = RecoveryChange(i, p.recoveryPk, p.by, body.at)
                pending = null
            }
        }
        val named = if (body.op == "recovery") dir.recoveryPks + body.recoveryPk!! else dir.recoveryPks
        return Directory(dir.account, recoveryPk, members, i + 1, entryHash(env.body), recoverySet, pending, named)
    }

    /** Whether [pk] is any member's key or any recovery key the chain named, retired ones too: keys are never reused. */
    private fun keyInUse(dir: Directory, pk: String): Boolean =
        pk in dir.recoveryPks || dir.members.values.any { it.member.signPk == pk || it.member.boxPk == pk }

    // --- Writing entries -------------------------------------------------------

    fun genesisEntry(account: String, device: Member, signKey: ByteArray, recovery: KeyPair, at: String): SignedEnvelope {
        val body = buildJsonObject {
            put("v", 1)
            put("account", account)
            put("seq", 0)
            put("prev", JsonNull)
            put("at", at)
            put("op", "add")
            put("member", memberJson(device))
            put("recoveryPk", toB64(recovery.public))
        }
        val env = envelopes.sign("directory", body, device.id, signKey)
        val recoverySig = sodium.sign(signatureMessage("directory", RECOVERY, env.body), recovery.secret)
        return env.copy(recoverySig = toB64(recoverySig))
    }

    /** [signer] is an active device's id, or [RECOVERY] with the recovery private key. */
    fun addEntry(dir: Directory, signer: String, signKey: ByteArray, member: Member, at: String): SignedEnvelope =
        envelopes.sign("directory", entryBase(dir, at, "add") { put("member", memberJson(member)) }, signer, signKey)

    fun revokeEntry(dir: Directory, signer: String, signKey: ByteArray, id: String, at: String): SignedEnvelope =
        envelopes.sign("directory", entryBase(dir, at, "revoke") { put("id", id) }, signer, signKey)

    /** Proposes [recovery] as the recovery key: signed by an active device and by the new key. */
    fun recoveryEntry(dir: Directory, signer: String, signKey: ByteArray, recovery: KeyPair, at: String): SignedEnvelope {
        val env = envelopes.sign("directory", entryBase(dir, at, "recovery") { put("recoveryPk", toB64(recovery.public)) }, signer, signKey)
        val recoverySig = sodium.sign(signatureMessage("directory", RECOVERY, env.body), recovery.secret)
        return env.copy(recoverySig = toB64(recoverySig))
    }

    /** Confirms the pending proposal: [signer] is [RECOVERY] with the current key, or another active device. */
    fun recoveryConfirmEntry(dir: Directory, signer: String, signKey: ByteArray, at: String): SignedEnvelope {
        val pending = dir.pendingRecovery ?: throw ProtocolException("bad-recovery", "no pending proposal")
        return envelopes.sign("directory", entryBase(dir, at, "recovery-confirm") { put("proposal", pending.seq) }, signer, signKey)
    }

    private fun entryBase(dir: Directory, at: String, op: String, rest: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject {
        put("v", 1)
        put("account", dir.account)
        put("seq", dir.length)
        put("prev", dir.head)
        put("at", at)
        put("op", op)
        rest()
    }
}

private operator fun DirectoryMember.component1() = member

fun memberJson(m: Member): JsonObject = buildJsonObject {
    put("id", m.id)
    put("role", m.role)
    put("name", m.name)
    put("boxPk", m.boxPk)
    put("signPk", m.signPk)
}

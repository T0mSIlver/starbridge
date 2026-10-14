package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Detecting a withheld directory entry from the heads machines sign into their items (heads.ts,
 * PROTOCOL.md "Directory"). Heads are kept by signer. Heads kept before #1627 may also sit under
 * "signer/by" or "signer/?", where machines before #794 put a device's head they passed on: each
 * counts as a head its signer vouched for, since only the signer signed it, and goes when either
 * the signer's or the by's heads are forgotten (#1730).
 */
class Heads(private val directories: Directories) {
    /** Whether [entries] hold the chain [head] names: as long at least, and the same entry there. */
    fun holds(entries: List<JsonElement>, head: DirectoryHead): Boolean {
        if (head.length > entries.size) return false
        val env = runCatching { ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), entries[head.length - 1]) }.getOrNull()
        return env != null && directories.entryHash(env.body) == head.head
    }

    /** The `revoke` entry of [entries] that names member [id], if any; a `recover` names no one (heads.ts `revocationOf`). */
    fun revocationOf(entries: List<JsonElement>, id: String): Revocation? {
        for (raw in entries) {
            val env = runCatching { ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw) }.getOrNull() ?: continue
            val body = runCatching { ProtocolJson.parseToJsonElement(env.body).jsonObject }.getOrNull() ?: continue
            fun field(name: String) = body[name]?.jsonPrimitive?.contentOrNull
            if (field("op") == "revoke" && field("id") == id) return Revocation(id, env.signer, field("at") ?: "")
        }
        return null
    }

    /**
     * Whether a head [id] signed no longer counts: [dir] lists it as
     * revoked, and a `recover` came after any `revoke` that names it. A `revoke` ends nothing,
     * since a revoked device can forge one on a fork of a stale chain (#813); a `recover`, which
     * only the recovery key signs, ends every earlier hold (heads.ts `removed`).
     */
    private fun removed(dir: Directory, entries: List<JsonElement>, id: String): Boolean {
        if (dir.members[id]?.active != false) return false
        var revokedAt = -1
        var recoveredAt = -1
        entries.forEachIndexed { i, raw ->
            val env = runCatching { ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), raw) }.getOrNull() ?: return@forEachIndexed
            val body = runCatching { ProtocolJson.parseToJsonElement(env.body).jsonObject }.getOrNull() ?: return@forEachIndexed
            val op = body["op"]?.jsonPrimitive?.contentOrNull
            if (op == "revoke" && body["id"]?.jsonPrimitive?.contentOrNull == id) revokedAt = i
            if (op == "recover") recoveredAt = i
        }
        return recoveredAt > revokedAt
    }

    /**
     * Records the head [signer] signed into an item. A shorter head never replaces a longer one
     * [entries] lack, so replaying an older item cannot lift a hold. A head that names a `by`,
     * which a machine before #794 passed on from a device, is not kept: it may lie on that
     * device's fork, and could push out the signer's own head that shows a gap (heads.ts
     * `noteHead`, #1627). True when it changed.
     */
    fun note(heads: MutableMap<String, DirectoryHead>, signer: String, head: DirectoryHead?, entries: List<JsonElement>): Boolean {
        if (head == null || head.by != null) return false
        val known = heads[signer]
        val replace = known == null || head.length > known.length || (holds(entries, known) && !holds(entries, head))
        if (replace) heads[signer] = head
        return replace
    }

    /**
     * A kept head [entries] lack, signed by a member [dir] lists that no `recover` removed
     * (heads.ts `withheldBy`). One whose signer a `revoke` names says so in `revoked`; a head
     * without one comes first. Null while none counts.
     */
    fun withheldBy(heads: Map<String, DirectoryHead>, dir: Directory, entries: List<JsonElement>): Withheld? {
        var fork: Withheld? = null
        for ((key, head) in heads) {
            val id = key.substringBefore("/")
            if (!dir.members.containsKey(id) || removed(dir, entries, id)) continue
            if (holds(entries, head)) continue
            val revoked = if (dir.members[id]?.active == true) null else revocationOf(entries, id)
            val own = DirectoryHead(head.length, head.head)
            if (revoked == null) return Withheld(id, own)
            if (fork == null) fork = Withheld(id, own, revoked)
        }
        return fork
    }

    /**
     * Drops every kept head member [id] signed, and every head kept before #1627 that a machine
     * passed on from [id] (heads.ts `forgetHeads`, #1730). True when any went.
     */
    fun forget(heads: MutableMap<String, DirectoryHead>, id: String): Boolean =
        heads.keys.removeIf { it.substringBefore("/") == id || (it.contains("/") && it.substringAfter("/") == id) }
}

/** A machine [id] signed [head] and the chain lacks it; [revoked] names a `revoke` of it. */
data class Withheld(val id: String, val head: DirectoryHead, val revoked: Revocation? = null)
/** A `revoke` entry: the member [id] it names, the device [by] that signed it, and when. */
data class Revocation(val id: String, val by: String, val at: String)

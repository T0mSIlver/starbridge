package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Detecting a withheld directory entry from the heads machines sign into their items (heads.ts,
 * PROTOCOL.md "Directory"). Heads are kept by signer, or by "signer/by" for a head the signer
 * passed on from member `by`.
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
     * Whether a head [id] signed, or that names it as `by`, no longer counts: [dir] lists it as
     * revoked and no `revoke` names it, so a `recover` removed it. A `revoke` ends nothing, since
     * a revoked device can forge one on a fork of a stale chain (#813).
     */
    private fun removed(dir: Directory, entries: List<JsonElement>, id: String) =
        dir.members[id]?.active == false && revocationOf(entries, id) == null

    /**
     * Records the head [signer] signed into an item. A shorter head never replaces a longer one
     * [entries] lack, so replaying an older item cannot lift a hold. With [dir], a `by` that chain
     * does not list goes in the signer's one unknown slot, "signer/?", and a head passed on from a
     * `by` it lists as revoked is not kept, so a head the owner forgot does not come back when its
     * item is read again (heads.ts `noteHead`). True when it changed.
     */
    fun note(heads: MutableMap<String, DirectoryHead>, signer: String, head: DirectoryHead?, entries: List<JsonElement>, dir: Directory? = null): Boolean {
        if (head == null) return false
        val by = head.by?.takeIf { it != signer }
        if (by != null && dir?.members?.get(by)?.active == false) return false
        val key = when {
            by == null -> signer
            dir != null && !dir.members.containsKey(by) -> "$signer/?"
            else -> "$signer/$by"
        }
        val known = heads[key]
        // A head passed on from a member a `recover` removed counts no more: any head replaces it.
        val dropped = known?.by != null && dir != null && removed(dir, entries, known.by)
        val replace = known == null || dropped || head.length > known.length || (holds(entries, known) && !holds(entries, head))
        if (replace) heads[key] = head
        return replace
    }

    /**
     * A kept head [entries] lack, signed by a member [dir] lists, neither it nor its `by` removed
     * by a `recover` (heads.ts `withheldBy`). One whose member a `revoke` names says so in
     * `revoked`; a head without one comes first. Null while none counts.
     */
    fun withheldBy(heads: Map<String, DirectoryHead>, dir: Directory, entries: List<JsonElement>): Withheld? {
        var fork: Withheld? = null
        for ((key, head) in heads) {
            val id = key.substringBefore("/")
            val by = head.by?.takeIf { it != id }
            if (!dir.members.containsKey(id) || removed(dir, entries, id)) continue
            if (by != null && removed(dir, entries, by)) continue
            if (holds(entries, head)) continue
            val revoked = (if (dir.members[id]?.active == true) null else revocationOf(entries, id))
                ?: by?.takeIf { dir.members[it]?.active == false }?.let { revocationOf(entries, it) }
            if (revoked == null) return Withheld(id, by, head)
            if (fork == null) fork = Withheld(id, by, head, revoked)
        }
        return fork
    }

    /** Drops every kept head member [id] signed or that names it as `by` (heads.ts `forgetHeads`). True when any went. */
    fun forget(heads: MutableMap<String, DirectoryHead>, id: String): Boolean =
        heads.entries.removeIf { (key, head) -> key.substringBefore("/") == id || head.by == id }
}

/** A machine [id] signed [head], passed on from device [by] when set, and the chain lacks it; [revoked] names a `revoke` of either. */
data class Withheld(val id: String, val by: String?, val head: DirectoryHead, val revoked: Revocation? = null)

/** A `revoke` entry: the member [id] it names, the device [by] that signed it, and when. */
data class Revocation(val id: String, val by: String, val at: String)

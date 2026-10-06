package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonElement

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

    /**
     * Records the head [signer] signed into an item. A shorter head never replaces a longer one
     * [entries] lack, so replaying an older item cannot lift a hold. With [dir], a `by` that chain
     * does not list goes in the signer's one unknown slot, "signer/?". True when it changed.
     */
    fun note(heads: MutableMap<String, DirectoryHead>, signer: String, head: DirectoryHead?, entries: List<JsonElement>, dir: Directory? = null): Boolean {
        if (head == null) return false
        val by = head.by?.takeIf { it != signer }
        val key = when {
            by == null -> signer
            dir != null && !dir.members.containsKey(by) -> "$signer/?"
            else -> "$signer/$by"
        }
        val known = heads[key]
        // A head passed on from a member the chain now revokes counts no more: any head replaces it.
        val dropped = known?.by != null && dir?.members?.get(known.by)?.active == false
        val replace = known == null || dropped || head.length > known.length || (holds(entries, known) && !holds(entries, head))
        if (replace) heads[key] = head
        return replace
    }

    /**
     * A kept head [entries] lack, signed by a member active in [dir] and passed on from no member
     * [dir] lists as revoked (heads.ts `withheldBy`); null while none counts.
     */
    fun withheldBy(heads: Map<String, DirectoryHead>, dir: Directory, entries: List<JsonElement>): Withheld? {
        for ((key, head) in heads) {
            val id = key.substringBefore("/")
            val by = head.by?.takeIf { it != id }
            if (dir.members[id]?.active != true) continue
            if (by != null && dir.members[by]?.active == false) continue
            if (!holds(entries, head)) return Withheld(id, by, head)
        }
        return null
    }
}

/** A machine [id] signed [head], passed on from device [by] when set, and the chain lacks it. */
data class Withheld(val id: String, val by: String?, val head: DirectoryHead)

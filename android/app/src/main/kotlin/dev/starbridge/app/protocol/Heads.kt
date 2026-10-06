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
     * [entries] lack, so replaying an older item cannot lift a hold. True when it changed.
     */
    fun note(heads: MutableMap<String, DirectoryHead>, signer: String, head: DirectoryHead?, entries: List<JsonElement>): Boolean {
        if (head == null) return false
        val key = if (head.by != null && head.by != signer) "$signer/${head.by}" else signer
        val known = heads[key]
        val replace = known == null || head.length > known.length || (holds(entries, known) && !holds(entries, head))
        if (replace) heads[key] = head
        return replace
    }

    /**
     * A kept head [entries] lack while every member it counts on (its signer, and the member it
     * came from) is active in [dir], with the member it names; null while none counts.
     */
    fun withheldBy(heads: Map<String, DirectoryHead>, dir: Directory, entries: List<JsonElement>): Pair<String, DirectoryHead>? {
        for ((key, head) in heads) {
            val ids = key.split("/")
            if (ids.all { dir.members[it]?.active == true } && !holds(entries, head)) return ids.last() to head
        }
        return null
    }
}

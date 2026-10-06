package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonElement

/**
 * Detecting a withheld directory entry from the heads machines sign into their items (heads.ts,
 * PROTOCOL.md "Directory"). Heads are kept by member id.
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
        val known = heads[signer]
        val replace = known == null || head.length > known.length || (holds(entries, known) && !holds(entries, head))
        if (replace) heads[signer] = head
        return replace
    }

    /** A member active in [dir] that signed a head [entries] lack, with that head; null while none has. */
    fun withheldBy(heads: Map<String, DirectoryHead>, dir: Directory, entries: List<JsonElement>): Pair<String, DirectoryHead>? =
        heads.entries.firstOrNull { (id, head) -> dir.members[id]?.active == true && !holds(entries, head) }?.toPair()
}

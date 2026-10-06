package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.protocol.DirectoryHead
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Heads
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** heads.test.ts on the phone: a machine's signed head exposes a revocation the server withholds (#362). */
class HeadsTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val directories = Directories(sodium, Envelopes(sodium))
    private val heads = Heads(directories)
    private val at = "2026-10-06T12:00:00Z"

    @Test
    fun aMachineThatHoldsTheRevocationExposesIt() {
        val sign = mapOf("a" to sodium.signKeyPair(), "b" to sodium.signKeyPair(), "m" to sodium.signKeyPair(), "m2" to sodium.signKeyPair())
        fun member(id: String) = Member(id, if (id.startsWith("m")) "machine" else "device", id, toB64(sodium.boxKeyPair().public), toB64(sign.getValue(id).public))
        val chain = mutableListOf<JsonElement>(envelopeJson(directories.genesisEntry("acct", member("a"), sign.getValue("a").secret, sodium.signKeyPair(), at)))
        for (id in listOf("b", "m", "m2")) chain += envelopeJson(directories.addEntry(directories.verify(chain), "a", sign.getValue("a").secret, member(id), at))
        val seenByA = chain.toList()
        val truth = chain + envelopeJson(directories.revokeEntry(directories.verify(chain), "b", sign.getValue("b").secret, "m", at))
        val mine = directories.verify(seenByA)
        val full = directories.verify(truth)
        val fullHead = DirectoryHead(full.length, full.head)

        assertTrue(heads.holds(truth, fullHead))
        assertFalse(heads.holds(seenByA, fullHead))
        val known = mutableMapOf<String, DirectoryHead>()
        assertTrue(heads.note(known, "m2", fullHead, seenByA))
        assertEquals("m2", heads.withheldBy(known, mine, seenByA)?.id)
        // An older item with a shorter head, replayed, does not lift the hold.
        assertFalse(heads.note(known, "m2", DirectoryHead(mine.length, mine.head), seenByA))
        assertEquals("m2", heads.withheldBy(known, mine, seenByA)?.id)
        assertNull(heads.withheldBy(known, full, truth))
        // A head counts only while the member that signed it is active.
        val revoked = mapOf("m" to DirectoryHead(full.length + 5, "A".repeat(43)))
        assertNull(heads.withheldBy(revoked, full, truth))
        assertEquals("m", heads.withheldBy(revoked, mine, seenByA)?.id)

        // A forged head an honest machine passed on from device b ends with b's revocation.
        val relayed = mutableMapOf<String, DirectoryHead>()
        heads.note(relayed, "m2", DirectoryHead(99, "A".repeat(43), by = "b"), seenByA)
        assertEquals("b", heads.withheldBy(relayed, mine, seenByA)?.by)
        val withoutB = seenByA + envelopeJson(directories.revokeEntry(mine, "a", sign.getValue("a").secret, "b", at))
        assertNull(heads.withheldBy(relayed, directories.verify(withoutB), withoutB))

        // A head passed on from a device this chain does not list yet counts, in one slot per machine.
        val unknown = mutableMapOf<String, DirectoryHead>()
        heads.note(unknown, "m2", DirectoryHead(99, "A".repeat(43), by = "c"), seenByA, mine)
        heads.note(unknown, "m2", DirectoryHead(98, "B".repeat(43), by = "d"), seenByA, mine)
        assertEquals(setOf("m2/?"), unknown.keys)
        assertEquals("c", heads.withheldBy(unknown, mine, seenByA)?.by)
        // Once the chain revokes the device a kept head names, any head from that machine replaces it.
        val withD = seenByA + envelopeJson(directories.addEntry(mine, "a", sign.getValue("a").secret, Member("c", "device", "c", toB64(sodium.boxKeyPair().public), toB64(sodium.signKeyPair().public)), at))
        val revokedC = withD + envelopeJson(directories.revokeEntry(directories.verify(withD), "a", sign.getValue("a").secret, "c", at))
        val afterC = directories.verify(revokedC)
        assertTrue(heads.note(unknown, "m2", DirectoryHead(7, "C".repeat(43), by = "e"), revokedC, afterC))
        assertEquals("e", heads.withheldBy(unknown, afterC, revokedC)?.by)
    }
}

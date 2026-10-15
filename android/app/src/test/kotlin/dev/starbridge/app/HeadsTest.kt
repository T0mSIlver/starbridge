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
        // A revoke of the member that signed a head does not end it (#813): it says who revoked it.
        val revoked = mutableMapOf("m" to DirectoryHead(full.length + 5, "A".repeat(43)))
        assertEquals("b", heads.withheldBy(revoked, full, truth)?.revoked?.by)
        assertNull(heads.withheldBy(revoked, mine, seenByA)?.revoked)
        // The owner's word does.
        assertTrue(heads.forget(revoked, "m"))
        assertNull(heads.withheldBy(revoked, full, truth))

        // A head a machine before #794 passed on is not kept, so it cannot push out m2's own (#1627).
        assertFalse(heads.note(known, "m2", DirectoryHead(99, "A".repeat(43), by = "b"), seenByA))
        // Heads kept before #1627 under "signer/by" or "signer/?" count as their signer's, and go
        // with it or with the by (#1730).
        val kept = mutableMapOf("m2/b" to fullHead, "m2/?" to DirectoryHead(99, "A".repeat(43)))
        assertEquals("m2", heads.withheldBy(kept, mine, seenByA)?.id)
        assertTrue(heads.forget(kept, "b"))
        assertEquals(setOf("m2/?"), kept.keys)
        assertTrue(heads.forget(kept, "m2"))
        assertTrue(kept.isEmpty())
    }
}

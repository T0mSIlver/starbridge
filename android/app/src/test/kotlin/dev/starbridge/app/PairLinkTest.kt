package dev.starbridge.app

import dev.starbridge.app.protocol.otherServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A code from another server names that server when its lookup fails (#671). */
class PairLinkTest {
    @Test
    fun namesOnlyAnotherServer() {
        assertEquals("starbridge.run", otherServer("https://starbridge.run/pair#ABCD", "https://sb.example.com"))
        assertNull(otherServer("https://sb.example.com/pair#ABCD", "https://SB.example.com:443/"))
        assertNull(otherServer("ABCD-EFGH", "https://sb.example.com"))
    }
}

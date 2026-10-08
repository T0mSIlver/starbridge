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
        // A machine's QR code names its server in the query (#795).
        assertEquals("sb.example.com:8443", otherServer("starbridge://pair?server=https%3A%2F%2Fsb.example.com%3A8443&k=X#ABCD", "https://starbridge.run"))
        assertNull(otherServer("starbridge://pair?server=https%3A%2F%2Fstarbridge.run&k=X#ABCD", "https://starbridge.run/"))
    }
}

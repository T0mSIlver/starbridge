package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.crypto.Envelope
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

// libsodium through Lazysodium's JVM build: the same API the app calls on Android.
class SodiumTest {
    private val envelope = Envelope(LazySodiumJava(SodiumJava()))

    @Test
    fun sealedBoxOpensOnlyForItsRecipient() {
        val phone = envelope.boxKeyPair()
        val other = envelope.boxKeyPair()
        val sealed = envelope.seal("Merge now?".toByteArray(), phone.public)
        assertArrayEquals("Merge now?".toByteArray(), envelope.open(sealed, phone))
        assertNull(envelope.open(sealed, other))
        sealed[sealed.size - 1] = (sealed.last() + 1).toByte()
        assertNull(envelope.open(sealed, phone))
    }

    @Test
    fun signatureVerifiesOnlyItsMessage() {
        val machine = envelope.signKeyPair()
        val signature = envelope.sign("answer".toByteArray(), machine.secret)
        assertTrue(envelope.verify(signature, "answer".toByteArray(), machine.public))
        assertFalse(envelope.verify(signature, "answer!".toByteArray(), machine.public))
    }

    @Test
    fun protocolVectors() {
        val dir = File(System.getProperty("starbridge.vectors") ?: "")
        // TODO(#1): packages/protocol/vectors lands with the protocol PR. Then open each
        // vector's sealed box with its keys and check its signatures against the plaintext.
        assumeTrue("packages/protocol/vectors not in the repo yet (#1)", dir.isDirectory)
    }
}

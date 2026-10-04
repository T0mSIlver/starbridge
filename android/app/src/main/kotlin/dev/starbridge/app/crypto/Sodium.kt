package dev.starbridge.app.crypto

import com.goterl.lazysodium.LazySodium
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.Sign
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

class KeyPair(val public: ByteArray, val secret: ByteArray)

/**
 * The envelope's primitives (SPEC.md, "Keys and trust"): sealed boxes to a
 * device's X25519 key, Ed25519 detached signatures. libsodium does the
 * cryptography; this class only sizes the buffers.
 */
class Envelope(private val sodium: LazySodium) {
    fun boxKeyPair(): KeyPair {
        val pk = ByteArray(Box.PUBLICKEYBYTES)
        val sk = ByteArray(Box.SECRETKEYBYTES)
        check(sodium.cryptoBoxKeypair(pk, sk))
        return KeyPair(pk, sk)
    }

    fun signKeyPair(): KeyPair {
        val pk = ByteArray(Sign.PUBLICKEYBYTES)
        val sk = ByteArray(Sign.SECRETKEYBYTES)
        check(sodium.cryptoSignKeypair(pk, sk))
        return KeyPair(pk, sk)
    }

    fun seal(message: ByteArray, recipient: ByteArray): ByteArray {
        val sealed = ByteArray(message.size + Box.SEALBYTES)
        check(sodium.cryptoBoxSeal(sealed, message, message.size.toLong(), recipient))
        return sealed
    }

    /** Null when the box was not sealed to [keys] or was altered. */
    fun open(sealed: ByteArray, keys: KeyPair): ByteArray? {
        if (sealed.size < Box.SEALBYTES) return null
        val message = ByteArray(sealed.size - Box.SEALBYTES)
        return if (sodium.cryptoBoxSealOpen(message, sealed, sealed.size.toLong(), keys.public, keys.secret)) message else null
    }

    fun sign(message: ByteArray, secret: ByteArray): ByteArray {
        val signature = ByteArray(Sign.BYTES)
        check(sodium.cryptoSignDetached(signature, message, message.size.toLong(), secret))
        return signature
    }

    fun verify(signature: ByteArray, message: ByteArray, public: ByteArray): Boolean =
        signature.size == Sign.BYTES && sodium.cryptoSignVerifyDetached(signature, message, message.size, public)
}

@Module
@InstallIn(SingletonComponent::class)
object SodiumModule {
    @Provides @Singleton
    fun envelope(): Envelope = Envelope(LazySodiumAndroid(SodiumAndroid()))
}

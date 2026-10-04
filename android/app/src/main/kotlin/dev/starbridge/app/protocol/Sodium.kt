package dev.starbridge.app.protocol

import com.goterl.lazysodium.LazySodium
import com.goterl.lazysodium.interfaces.Auth
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.Sign
import java.util.Base64

class KeyPair(val public: ByteArray, val secret: ByteArray)

/**
 * The libsodium calls the protocol needs, as packages/protocol makes them. Lazysodium does the
 * cryptography; this class only sizes the buffers. Tests pass LazySodiumJava, the app
 * LazySodiumAndroid.
 */
class Sodium(private val ls: LazySodium) {
    fun boxKeyPair(): KeyPair {
        val pk = ByteArray(Box.PUBLICKEYBYTES)
        val sk = ByteArray(Box.SECRETKEYBYTES)
        check(ls.cryptoBoxKeypair(pk, sk))
        return KeyPair(pk, sk)
    }

    fun signKeyPair(): KeyPair {
        val pk = ByteArray(Sign.PUBLICKEYBYTES)
        val sk = ByteArray(Sign.SECRETKEYBYTES)
        check(ls.cryptoSignKeypair(pk, sk))
        return KeyPair(pk, sk)
    }

    fun signSeedKeyPair(seed: ByteArray): KeyPair {
        require(seed.size == Sign.SEEDBYTES)
        val pk = ByteArray(Sign.PUBLICKEYBYTES)
        val sk = ByteArray(Sign.SECRETKEYBYTES)
        check(ls.cryptoSignSeedKeypair(pk, sk, seed))
        return KeyPair(pk, sk)
    }

    fun seal(message: ByteArray, recipient: ByteArray): ByteArray {
        val sealed = ByteArray(message.size + Box.SEALBYTES)
        check(ls.cryptoBoxSeal(sealed, message, message.size.toLong(), recipient))
        return sealed
    }

    /** Null when the box was not sealed to [keys] or was altered. */
    fun sealOpen(sealed: ByteArray, keys: KeyPair): ByteArray? {
        if (sealed.size < Box.SEALBYTES) return null
        val message = ByteArray(sealed.size - Box.SEALBYTES)
        return if (ls.cryptoBoxSealOpen(message, sealed, sealed.size.toLong(), keys.public, keys.secret)) message else null
    }

    fun sign(message: ByteArray, secret: ByteArray): ByteArray {
        val signature = ByteArray(Sign.BYTES)
        check(ls.cryptoSignDetached(signature, message, message.size.toLong(), secret))
        return signature
    }

    fun verify(signature: ByteArray, message: ByteArray, public: ByteArray): Boolean =
        signature.size == Sign.BYTES && public.size == Sign.PUBLICKEYBYTES &&
            ls.cryptoSignVerifyDetached(signature, message, message.size, public)

    /** BLAKE2b-256, unkeyed. */
    fun hash(message: ByteArray): ByteArray {
        val out = ByteArray(32)
        check(ls.cryptoGenericHash(out, out.size, message, message.size.toLong(), null, 0))
        return out
    }

    /** HMAC-SHA-512-256. */
    fun auth(message: ByteArray, key: ByteArray): ByteArray {
        val tag = ByteArray(Auth.BYTES)
        check(ls.cryptoAuth(tag, message, message.size.toLong(), key))
        return tag
    }

    fun authVerify(tag: ByteArray, message: ByteArray, key: ByteArray): Boolean =
        tag.size == Auth.BYTES && ls.cryptoAuthVerify(tag, message, message.size.toLong(), key)

    fun random(n: Int): ByteArray = ls.randomBytesBuf(n)
}

private val B64 = Regex("^[A-Za-z0-9_-]*$")

/** Base64url without padding, the only binary encoding on the wire. */
fun toB64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

fun fromB64(text: String): ByteArray {
    if (!B64.matches(text) || text.length % 4 == 1) throw ProtocolException("bad-encoding", "not base64url without padding")
    val bytes = try {
        Base64.getUrlDecoder().decode(text)
    } catch (e: IllegalArgumentException) {
        throw ProtocolException("bad-encoding", e.message)
    }
    // libsodium refuses leftover bits that are not zero; so does this.
    if (toB64(bytes) != text) throw ProtocolException("bad-encoding", "non-canonical base64url")
    return bytes
}

fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

fun concat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var at = 0
    for (p in parts) {
        p.copyInto(out, at)
        at += p.size
    }
    return out
}

/**
 * Error codes are part of the protocol: packages/protocol's test vectors name them, and this
 * client reports the same ones (packages/protocol/src/sodium.ts).
 */
class ProtocolException(val code: String, detail: String? = null) : Exception(if (detail != null) "$code: $detail" else code)

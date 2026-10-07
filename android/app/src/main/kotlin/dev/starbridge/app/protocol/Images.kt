package dev.starbridge.app.protocol

import com.goterl.lazysodium.interfaces.SecretBox

/**
 * A decision's image, sealed once for every device (images.ts): the blob is the nonce then
 * crypto_secretbox of the image under the signed key, and the signed hash is BLAKE2b-256 of
 * "starbridge/v1/image" NUL and the blob (#685).
 */
class Images(private val sodium: Sodium) {
    /** The image's bytes; `cannot-open` when the blob does not match the hash or the key. */
    fun open(blob: String, key: String, hash: String): ByteArray {
        val bytes = try {
            fromB64(blob)
        } catch (e: ProtocolException) {
            throw ProtocolException("cannot-open", "image blob is not base64url")
        }
        if (toB64(sodium.hash(concat(LABEL, bytes))) != hash) throw ProtocolException("cannot-open", "image hash differs")
        if (bytes.size < SecretBox.NONCEBYTES + SecretBox.MACBYTES) throw ProtocolException("cannot-open", "image blob too short")
        val k = try {
            fromB64(key)
        } catch (e: ProtocolException) {
            throw ProtocolException("cannot-open", "image key is not base64url")
        }
        return sodium.secretboxOpen(bytes.copyOfRange(SecretBox.NONCEBYTES, bytes.size), bytes.copyOfRange(0, SecretBox.NONCEBYTES), k)
            ?: throw ProtocolException("cannot-open", "image does not open")
    }

    /** Each of [images] opened from [blobs], as base64url; null where one is missing or fails. */
    fun openAll(images: List<DecisionImage>, blobs: List<String>?): List<String?> =
        images.mapIndexed { i, img ->
            blobs?.getOrNull(i)?.let { runCatching { toB64(open(it, img.key, img.hash)) }.getOrNull() }
        }

    private companion object {
        val LABEL = concat(utf8("starbridge/v1/image"), byteArrayOf(0))
    }
}

package dev.starbridge.app.protocol

/**
 * The Ed25519 seed of the recovery key: the 16-byte recovery seed stretched with BLAKE2b-256 of
 * "starbridge/v1/recovery-seed", NUL, the seed (`recoveryKeyPair`).
 */
fun recoverySignSeed(seed: ByteArray, sodium: Sodium): ByteArray {
    require(seed.size == 16) { "a recovery seed is 16 bytes" }
    return sodium.hash("starbridge/v1/recovery-seed".toByteArray() + byteArrayOf(0) + seed)
}

/**
 * The recovery key, as `recoveryKey` and `readRecoveryKey` in packages/protocol: the 16-byte seed
 * and a 12-bit check, 140 bits as 28 Crockford base32 characters in seven groups of four.
 */
object RecoveryKeys {
    private const val CHARS = 28

    class Reading(val count: Int, val problem: String?) {
        val complete get() = problem == null && count == CHARS
        val status get() = "$count of $CHARS characters"
    }

    /** The first 12 bits of BLAKE2b-256 of "starbridge/v1/recovery-check", NUL, the seed. */
    private fun check(seed: ByteArray, sodium: Sodium): ByteArray {
        val h = sodium.hash("starbridge/v1/recovery-check".toByteArray() + byteArrayOf(0) + seed)
        return byteArrayOf(h[0], (h[1].toInt() and 0xf0).toByte())
    }

    fun encode(seed: ByteArray, sodium: Sodium): String {
        require(seed.size == 16)
        return encodeCrockford(seed + check(seed, sodium)).take(CHARS).chunked(4).joinToString("-")
    }

    private fun chars(text: String) = text.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace(Regex("[IL]"), "1")

    /** 28 characters to bytes, with one padding character so the check's last 4 bits land in byte 17. */
    private fun bytes(chars: String): ByteArray {
        val out = mutableListOf<Byte>()
        var bits = 0
        var value = 0
        for (c in chars + "0") {
            value = (value shl 5) or CROCKFORD.indexOf(c)
            bits += 5
            if (bits >= 8) {
                out.add(((value ushr (bits - 8)) and 0xff).toByte())
                bits -= 8
            }
            value = value and ((1 shl bits) - 1)
        }
        return out.toByteArray()
    }

    /** While typing (no [sodium]), only what more typing cannot fix counts. */
    fun read(text: String, sodium: Sodium? = null): Reading {
        val chars = chars(text)
        val bad = chars.indexOfFirst { it !in CROCKFORD }
        val problem = when {
            bad >= 0 -> "Character ${bad + 1}, \"${chars[bad]}\", is not in a recovery key."
            sodium == null -> null
            chars.length != CHARS -> "A recovery key has $CHARS characters; this has ${chars.length}."
            !bytes(chars).let { b -> check(b.copyOf(16), sodium).let { c -> b[16] == c[0] && (b[17].toInt() and 0xf0).toByte() == c[1] } } ->
                "A character is wrong. Check each group against what you wrote down."
            else -> null
        }
        return Reading(chars.length, problem)
    }

    /** The seed behind a typed key; throws with what is wrong. */
    fun seed(text: String, sodium: Sodium): ByteArray {
        read(text, sodium).problem?.let { throw IllegalArgumentException(it) }
        return bytes(chars(text)).copyOf(16)
    }
}

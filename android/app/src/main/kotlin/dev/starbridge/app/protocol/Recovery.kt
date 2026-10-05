package dev.starbridge.app.protocol

import java.security.MessageDigest

// The recovery seed as BIP-39 English words, as @scure/bip39 encodes it in packages/protocol: 16 bytes
// as 12 words, or 32 bytes as 24 for accounts made before 2026-10-05.
// The wordlist is BIP-39's english.txt (SHA-256 2f5eed53…dbda).

object Bip39 {
    val words: List<String> by lazy {
        val stream = Bip39::class.java.getResourceAsStream("/bip39-english.txt") ?: error("bip39-english.txt missing")
        stream.bufferedReader().readLines().filter { it.isNotBlank() }.also { check(it.size == 2048) }
    }
    private val index by lazy { words.withIndex().associate { (i, w) -> w to i } }

    private fun bits(bytes: ByteArray): String = bytes.joinToString("") { (it.toInt() and 0xff).toString(2).padStart(8, '0') }

    fun entropyToMnemonic(entropy: ByteArray): String {
        require(entropy.size in 16..32 && entropy.size % 4 == 0)
        val checksum = bits(MessageDigest.getInstance("SHA-256").digest(entropy)).take(entropy.size * 8 / 32)
        return (bits(entropy) + checksum).chunked(11).joinToString(" ") { words[it.toInt(2)] }
    }

    /** Throws on an unknown word or a bad checksum: BIP-39 words carry one. */
    fun mnemonicToEntropy(mnemonic: String): ByteArray {
        val list = mnemonic.trim().lowercase().split(Regex("\\s+"))
        if (list.size !in setOf(12, 15, 18, 21, 24)) throw IllegalArgumentException("recovery words are not valid")
        val all = list.joinToString("") { w -> (index[w] ?: throw IllegalArgumentException("unknown word: $w")).toString(2).padStart(11, '0') }
        val entropyBits = all.length * 32 / 33
        val entropy = all.take(entropyBits).chunked(8).map { it.toInt(2).toByte() }.toByteArray()
        if (bits(MessageDigest.getInstance("SHA-256").digest(entropy)).take(all.length - entropyBits) != all.drop(entropyBits)) {
            throw IllegalArgumentException("recovery words are not valid")
        }
        return entropy
    }

    /** The words in typed text, lowercased: anything that is not a letter separates them. */
    fun split(text: String): List<String> = text.lowercase().split(Regex("[^\\p{L}]+")).filter { it.isNotEmpty() }

    /** What is wrong with [words]: the first unknown word, else a count other than 12 or 24, else the checksum. */
    fun problem(words: List<String>): String? {
        val unknown = words.indexOfFirst { it !in index }
        if (unknown >= 0) return "Word ${unknown + 1}, \"${words[unknown]}\", is not a recovery word."
        if (words.size != 12 && words.size != 24) return "A recovery key has 12 words, or 24 for an older account; this has ${words.size}."
        return try {
            mnemonicToEntropy(words.joinToString(" "))
            null
        } catch (e: IllegalArgumentException) {
            "One word is wrong, or two are swapped. Check each word and the order."
        }
    }
}

/**
 * The Ed25519 seed of the recovery key: a 32-byte recovery seed is it, a 16-byte one is stretched
 * with BLAKE2b-256 of "starbridge/v1/recovery-seed", NUL, the seed (`recoveryKeyPair`).
 */
fun recoverySignSeed(seed: ByteArray, sodium: Sodium): ByteArray = when (seed.size) {
    32 -> seed
    16 -> sodium.hash("starbridge/v1/recovery-seed".toByteArray() + byteArrayOf(0) + seed)
    else -> throw IllegalArgumentException("a recovery seed is 16 or 32 bytes")
}

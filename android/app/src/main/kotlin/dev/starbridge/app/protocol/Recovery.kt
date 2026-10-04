package dev.starbridge.app.protocol

import java.security.MessageDigest

// The recovery seed as 24 BIP-39 English words, as @scure/bip39 encodes it in packages/protocol.
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
}

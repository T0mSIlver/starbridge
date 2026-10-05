package dev.starbridge.app.protocol

import java.security.MessageDigest

// The recovery seed shows as a recovery key (RecoveryKeys). Older accounts were shown BIP-39 English
// words, as @scure/bip39 encodes them in packages/protocol: 24 for a 32-byte seed, 12 for a 16-byte one.
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
        if (unknown >= 0) return "Word ${unknown + 1}, \"${words[unknown]}\", is not on the word list."
        if (words.size != 12 && words.size != 24) return "Older accounts recover with 12 or 24 words; this has ${words.size}."
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

/**
 * The recovery key, as `recoveryKey` and `readRecoveryKey` in packages/protocol: the 16-byte seed
 * and a 12-bit check, 140 bits as 28 Crockford base32 characters in seven groups of four. Typed
 * text that looks like words is read as an older account's words.
 */
object RecoveryKeys {
    private const val CHARS = 28

    class Reading(val words: Boolean, val count: Int, val problem: String?) {
        val complete get() = problem == null && if (words) count == 12 || count == 24 else count == CHARS
        val status get() = if (words) "$count of ${if (count > 12) 24 else 12} words" else "$count of $CHARS characters"
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

    private val wordRun = Regex("(^|[^\\p{L}\\p{N}])\\p{L}{5,8}[^\\p{L}\\p{N}]")
    private val letterRuns = Regex("(?<![\\p{L}\\p{N}])\\p{L}{3,}(?![\\p{L}\\p{N}])")

    private fun looksLikeWords(text: String): Boolean {
        if (wordRun.containsMatchIn(text) || letterRuns.findAll(text).count() >= 8) return true
        val words = Bip39.split(text)
        return words.size >= 12 && words.all { it in Bip39.words }
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
        if (looksLikeWords(text)) {
            val words = Bip39.split(text)
            val finished = if (sodium == null && text.lastOrNull()?.isLetter() == true) words.dropLast(1) else words
            val problem = Bip39.problem(finished)
            return Reading(true, words.size, if (sodium == null && problem?.startsWith("Word ") != true) null else problem)
        }
        val chars = chars(text)
        // A U in a word from the list, or the start of one, may be an older account's words,
        // which only read as words from the eighth: while typing, it waits.
        val maybeWords = sodium == null && Bip39.split(text).any { w -> w.length >= 3 && 'u' in w && Bip39.words.any { it.startsWith(w) } }
        val bad = chars.indexOfFirst { it !in CROCKFORD && !(maybeWords && it == 'U') }
        val problem = when {
            bad >= 0 -> "Character ${bad + 1}, \"${chars[bad]}\", is not in a recovery key."
            sodium == null -> null
            chars.length != CHARS -> "A recovery key has $CHARS characters; this has ${chars.length}."
            !bytes(chars).let { b -> check(b.copyOf(16), sodium).let { c -> b[16] == c[0] && (b[17].toInt() and 0xf0).toByte() == c[1] } } ->
                "A character is wrong. Check each group against what you wrote down."
            else -> null
        }
        return Reading(false, chars.length, problem)
    }

    /** The seed behind a typed key or older account's words; throws with what is wrong. */
    fun seed(text: String, sodium: Sodium): ByteArray {
        val reading = read(text, sodium)
        reading.problem?.let { throw IllegalArgumentException(it) }
        return if (reading.words) Bip39.mnemonicToEntropy(Bip39.split(text).joinToString(" ")) else bytes(chars(text)).copyOf(16)
    }

    /** What the first device shows: a key for a 16-byte seed, words for an older 32-byte one. */
    fun shown(seed: ByteArray, sodium: Sodium): String = if (seed.size == 16) encode(seed, sodium) else Bip39.entropyToMnemonic(seed)
}

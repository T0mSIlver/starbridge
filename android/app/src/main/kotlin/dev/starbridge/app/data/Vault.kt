package dev.starbridge.app.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Wraps secrets (private keys, the session token) before they touch the disk. */
interface Vault {
    fun wrap(plain: ByteArray): ByteArray
    fun unwrap(wrapped: ByteArray): ByteArray
}

/**
 * AES-256-GCM under a key that lives in the Android Keystore and never leaves it. The key does
 * not require an unlocked screen, so a notification's buttons can answer from the lock screen;
 * the files it wraps sit in credential-encrypted storage, readable after the first unlock.
 */
class KeystoreVault : Vault {
    private val alias = "starbridge-vault"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as SecretKey?)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    /** The blob's format: this byte, the IV's length, the IV, then the ciphertext and its tag. */
    private val format: Byte = 1

    override fun wrap(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        return byteArrayOf(format, iv.size.toByte()) + iv + cipher.doFinal(plain)
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        require(wrapped[0] == format) { "a vault blob of format ${wrapped[0]}" }
        val ivSize = wrapped[1].toInt()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, wrapped, 2, ivSize))
        return cipher.doFinal(wrapped, 2 + ivSize, wrapped.size - 2 - ivSize)
    }
}

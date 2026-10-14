package dev.starbridge.app.ui.setup

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CredentialManager
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import java.security.MessageDigest

/**
 * The recovery key on the clipboard (#817): marked sensitive, so keyboards and the clipboard
 * preview hide it, and cleared after [CLEAR_AFTER_MS] if it is still there. The timer lives in
 * this process, which Android freezes or kills once the app is behind, so the deadline is also
 * kept on disk, as a hash of the key, and [clearIfDue] honours it when the app next starts or
 * stops. Copying the key is meant to be followed by pasting it elsewhere, so leaving the app
 * does not clear it by itself.
 */
object KeyClipboard {
    const val CLEAR_AFTER_MS = 60_000L
    private const val PREFS = "key-clipboard"
    private val main = Handler(Looper.getMainLooper())
    private val token = Any()

    /** The wall clock, which the saved deadline is read against; a test moves it. */
    internal var wallClock: () -> Long = System::currentTimeMillis

    fun copy(context: Context, key: String) {
        val app = context.applicationContext
        val clipboard = app.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText("Starbridge recovery key", key)
        // Keyboards read the same extra before Android 13 under its literal name.
        val sensitive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        clip.description.extras = PersistableBundle().apply { putBoolean(sensitive, true) }
        clipboard.setPrimaryClip(clip)
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("deadline", wallClock() + CLEAR_AFTER_MS)
            .putString("hash", hash(key))
            .apply()
        main.removeCallbacksAndMessages(token)
        main.postDelayed({ clearIfDue(app, force = true) }, token, CLEAR_AFTER_MS)
    }

    /** Clears the clipboard if the key copied last is still on it and its time is up. */
    fun clearIfDue(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val hash = prefs.getString("hash", null) ?: return
        if (!force && wallClock() < prefs.getLong("deadline", 0)) return
        prefs.edit().clear().apply()
        clear(app.getSystemService(ClipboardManager::class.java), hash)
    }

    /**
     * Clears the clipboard if it holds the key. Android hides the clipboard from an app in the
     * background, and then it is cleared anyway: the key may still be on it.
     */
    private fun clear(clipboard: ClipboardManager, hash: String) {
        val clip = clipboard.primaryClip
        if (clip == null || clip.itemCount == 0 || clip.getItemAt(0).text?.toString()?.let(::hash) == hash) clipboard.clearPrimaryClip()
    }

    private fun hash(key: String) = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
}

/**
 * Saves the recovery key as a password through Credential Manager (#817), which reaches whichever
 * password manager the owner set: Google Password Manager, Bitwarden or 1Password. Returns null
 * when the owner backs out, else whether it was saved.
 */
suspend fun saveToPasswordManager(activity: Activity, key: String): Boolean? = try {
    CredentialManager.create(activity).createCredential(activity, CreatePasswordRequest(id = "Starbridge recovery key", password = key))
    true
} catch (_: CreateCredentialCancellationException) {
    null
} catch (_: CreateCredentialException) {
    false
}

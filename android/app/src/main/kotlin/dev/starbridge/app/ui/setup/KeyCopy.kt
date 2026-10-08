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

/**
 * The recovery key on the clipboard (#817): marked sensitive, so keyboards and the clipboard
 * preview hide it, and cleared after [CLEAR_AFTER_MS] if it is still there.
 */
object KeyClipboard {
    const val CLEAR_AFTER_MS = 60_000L
    private val main = Handler(Looper.getMainLooper())
    private val token = Any()

    fun copy(context: Context, key: String) {
        val clipboard = context.applicationContext.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText("Starbridge recovery key", key)
        // Keyboards read the same extra before Android 13 under its literal name.
        val sensitive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        clip.description.extras = PersistableBundle().apply { putBoolean(sensitive, true) }
        clipboard.setPrimaryClip(clip)
        main.removeCallbacksAndMessages(token)
        main.postDelayed({ clear(clipboard, key) }, token, CLEAR_AFTER_MS)
    }

    /**
     * Clears the clipboard if it holds [key]. Android hides the clipboard from an app in the
     * background, and then it is cleared anyway: the key may still be on it.
     */
    private fun clear(clipboard: ClipboardManager, key: String) {
        val clip = clipboard.primaryClip
        if (clip == null || clip.itemCount == 0 || clip.getItemAt(0).text?.toString() == key) clipboard.clearPrimaryClip()
    }
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

package dev.starbridge.app.push

import android.app.Notification
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.provider.Settings
import android.util.Log

/**
 * Whether a question answers from the lock screen (#1375): only while Android shows notifications'
 * sensitive content there. Otherwise its buttons ask for the unlock, and [AnswerReceiver] refuses an
 * answer that arrives while the phone is locked, as [PromptReceiver] refuses a locked Allow (#274).
 */
object LockScreen {
    // Readable by any app since Android 12 (@Readable), but not public constants.
    private const val SHOW = "lock_screen_show_notifications"
    private const val SHOW_PRIVATE = "lock_screen_allow_private_notifications"

    /**
     * SystemUI's own reading: notifications shown on the lock screen (unset counts as on), their
     * content shown (unset counts as off), no device policy hiding either, and no question channel
     * the owner set to hide its content.
     */
    fun showsContent(show: Int, showPrivate: Int, policy: Int, channels: List<Int>): Boolean =
        show != 0 &&
            showPrivate != 0 &&
            policy and (DevicePolicyManager.KEYGUARD_DISABLE_SECURE_NOTIFICATIONS or DevicePolicyManager.KEYGUARD_DISABLE_UNREDACTED_NOTIFICATIONS) == 0 &&
            channels.none { it == Notification.VISIBILITY_PRIVATE || it == Notification.VISIBILITY_SECRET }

    /**
     * Reads the settings of the profile the app runs in: a work profile has its own switch for
     * sensitive content. Anything unreadable counts as hidden.
     */
    fun showsContent(context: Context): Boolean = try {
        val resolver = context.contentResolver
        val manager = context.getSystemService(NotificationManager::class.java)
        showsContent(
            show = Settings.Secure.getInt(resolver, SHOW, 1),
            showPrivate = Settings.Secure.getInt(resolver, SHOW_PRIVATE, 0),
            policy = context.getSystemService(DevicePolicyManager::class.java)?.getKeyguardDisabledFeatures(null) ?: 0,
            channels = listOf(Notifier.WAITING, Notifier.QUESTIONS).mapNotNull { manager.getNotificationChannel(it)?.lockscreenVisibility },
        )
    } catch (e: Exception) {
        Log.w("Starbridge", "lock screen settings unreadable", e)
        false
    }
}

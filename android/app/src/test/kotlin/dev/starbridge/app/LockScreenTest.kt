package dev.starbridge.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.push.LockScreen
import dev.starbridge.app.push.Notifier
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant

// A question answers from the lock screen only while it shows sensitive content (#1375).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LockScreenTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val none = -1000 // NotificationManager.VISIBILITY_NO_OVERRIDE, hidden: a channel the owner left alone

    @After
    fun reset() {
        Settings.Secure.putString(context.contentResolver, "lock_screen_allow_private_notifications", null)
        Settings.Secure.putString(context.contentResolver, "lock_screen_show_notifications", null)
    }

    @Test
    fun onlyShownContentAnswers() {
        assertTrue(LockScreen.showsContent(show = 1, showPrivate = 1, policy = 0, channels = listOf(none, Notification.VISIBILITY_PUBLIC)))
        // Content hidden, or no notifications on the lock screen at all.
        assertFalse(LockScreen.showsContent(show = 1, showPrivate = 0, policy = 0, channels = listOf(none)))
        assertFalse(LockScreen.showsContent(show = 0, showPrivate = 1, policy = 0, channels = listOf(none)))
        // A device policy hides it.
        assertFalse(LockScreen.showsContent(1, 1, DevicePolicyManager.KEYGUARD_DISABLE_UNREDACTED_NOTIFICATIONS, listOf(none)))
        assertFalse(LockScreen.showsContent(1, 1, DevicePolicyManager.KEYGUARD_DISABLE_SECURE_NOTIFICATIONS, listOf(none)))
        assertTrue(LockScreen.showsContent(1, 1, DevicePolicyManager.KEYGUARD_DISABLE_FINGERPRINT, listOf(none)))
        // The owner hid it on one of the question channels.
        assertFalse(LockScreen.showsContent(1, 1, 0, listOf(none, Notification.VISIBILITY_PRIVATE)))
        assertFalse(LockScreen.showsContent(1, 1, 0, listOf(Notification.VISIBILITY_SECRET, none)))
    }

    @Test
    fun theButtonsAskForTheUnlockWhileContentIsHidden() {
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val notifier = Notifier(context, Prefs(context))
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val d = Fake(Instant.now()).decisions.first { it.id == "d1" }
        // Unset, as SystemUI reads it: content hidden.
        for ((private, unlock) in listOf(null to true, 0 to true, 1 to false)) {
            Settings.Secure.putString(context.contentResolver, "lock_screen_allow_private_notifications", private?.toString())
            assertEquals(!unlock, LockScreen.showsContent(context))
            notifier.clearAll()
            notifier.decision(d)
            val n = shadowOf(manager).allNotifications.single()
            for (actions in listOf(n.actions, n.publicVersion.actions)) {
                assertEquals(listOf("Server first", "CLI first", "Reply"), actions.map { it.title.toString() })
                assertTrue(actions.all { it.isAuthenticationRequired == unlock })
            }
        }
    }
}

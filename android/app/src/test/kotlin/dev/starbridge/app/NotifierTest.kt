package dev.starbridge.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.push.Notifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant

// What the shade and the lock screen get, which no screenshot shows (#182, #183, #184).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class NotifierTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val fake = Fake(Instant.now())
    private val notifier = Notifier(context, Prefs(context)).also {
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun posted(): Notification = shadowOf(context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).allNotifications.single()

    @Test
    fun aPromptShowsOnlyItsCommandAndKeepsItsButtonsOnTheLockScreen() {
        val p = fake.prompts.first()
        notifier.prompt(p)
        val n = posted()
        assertEquals(p.summary, n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
        assertFalse(n.allowSystemGeneratedContextualActions)
        assertEquals(listOf("Allow", "Deny"), n.publicVersion.actions.map { it.title.toString() })
        assertEquals(p.id, shadowOf(n.contentIntent).savedIntent.getStringExtra(MainActivity.EXTRA_PROMPT))
    }

    @Test
    fun aQuestionKeepsItsOptionsOnTheLockScreen() {
        val d = fake.decisions.first { it.id == "d1" }
        notifier.decision(d)
        val n = posted()
        assertEquals(listOf("Server first", "CLI first"), n.publicVersion.actions.map { it.title.toString() })
        assertFalse(n.allowSystemGeneratedContextualActions)
    }
}

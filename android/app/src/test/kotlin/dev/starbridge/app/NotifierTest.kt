package dev.starbridge.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import dev.starbridge.app.data.browserIntent
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.push.Notifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import androidx.core.app.NotificationCompat
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
    fun everyChannelSitsInAGroup() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assertEquals(emptyList<String>(), manager.notificationChannels.filter { it.group == null }.map { it.id })
    }

    // An artifact skips the Claude app, which shows it only in its in-app browser (#171).
    @Test
    fun anArtifactOpensInTheBrowserAndASessionDoesNot() {
        assertEquals(Intent.CATEGORY_BROWSABLE, browserIntent("https://claude.ai/artifact/abc").selector?.categories?.single())
        assertNull(browserIntent("https://claude.ai/code/session_01").selector)
    }

    @Test
    fun aQuestionKeepsItsOptionsOnTheLockScreen() {
        val d = fake.decisions.first { it.id == "d1" }
        notifier.decision(d)
        val n = posted()
        assertEquals(listOf("Server first", "CLI first"), n.publicVersion.actions.map { it.title.toString() })
        assertFalse(n.allowSystemGeneratedContextualActions)
    }

    // Waiting alerts on its own channel, the header ticking on the lock screen too; a flip back
    // moves it to "Questions" without a sound (#191).
    @Test
    fun aFlipMovesTheQuestionBetweenChannelsAndOnlyWaitingAlerts() {
        val waiting = fake.decisions.first { it.waiting }
        notifier.decision(waiting)
        posted().let {
            assertEquals(Notifier.WAITING, it.channelId)
            assertTrue(it.publicVersion.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        }
        notifier.decision(waiting.copy(waiting = false, waitingSince = null), silent = true)
        posted().let {
            assertEquals(Notifier.QUESTIONS, it.channelId)
            assertTrue(it.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER).not())
            assertEquals(NotificationCompat.GROUP_ALERT_SUMMARY, NotificationCompat.getGroupAlertBehavior(it))
        }
    }
}

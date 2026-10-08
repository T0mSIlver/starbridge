package dev.starbridge.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.ui.setup.KeyClipboard
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The copied recovery key is marked sensitive and leaves the clipboard after a minute (#817). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class KeyClipboardTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val clipboard = context.getSystemService(ClipboardManager::class.java)
    private val key = "7K2M-QX9D-T4HR-8VNC-W3JP-F6BZ-0E5A"

    @Test fun clearsTheKeyAfterAMinute() {
        KeyClipboard.copy(context, key)
        assertTrue(clipboard.primaryClip!!.description.extras.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(KeyClipboard.CLEAR_AFTER_MS - 1000))
        assertEquals(key, clipboard.primaryClip!!.getItemAt(0).text)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertFalse(clipboard.hasPrimaryClip() && clipboard.primaryClip!!.getItemAt(0).text == key)
    }

    @Test fun keepsWhatTheOwnerCopiedSince() {
        KeyClipboard.copy(context, key)
        clipboard.setPrimaryClip(ClipData.newPlainText("note", "something else"))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(KeyClipboard.CLEAR_AFTER_MS))
        assertEquals("something else", clipboard.primaryClip!!.getItemAt(0).text)
    }
}

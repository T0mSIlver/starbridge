package dev.starbridge.app

import android.content.Context
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.ui.inbox.SwipeToSnooze
import dev.starbridge.app.ui.refused
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * Haptics (#997): a refused answer rejects once, when its question comes back; the snooze swipe
 * ticks crossing its threshold and backing off it, but not when the card springs back after a
 * snooze.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class HapticsTest {
    @get:Rule val compose = createComposeRule()
    private val d = Fake(Instant.parse("2026-10-04T14:00:00Z")).decisions.first()

    @Test fun refusedOnlyWhenNotSentAppears() {
        val back = d.copy(notSent = "Not offered.")
        // Answered at the tap, the question left; it comes back refused.
        assertTrue(refused(emptyList(), listOf(back)))
        assertTrue(refused(listOf(d), listOf(back)))
        assertFalse(refused(listOf(back), listOf(back)))
        assertFalse(refused(listOf(back), emptyList()))
        assertTrue(refused(listOf(back), listOf(d.copy(notSent = "Offline."))))
    }

    private val types = mutableListOf<HapticFeedbackType>()
    private val played = mutableListOf<Int>()

    private fun card(onSwipe: () -> Unit = {}) {
        val view = object : View(ApplicationProvider.getApplicationContext<Context>()) {
            override fun performHapticFeedback(constant: Int): Boolean = played.add(constant)
        }
        compose.setContent {
            CompositionLocalProvider(
                LocalView provides view,
                LocalHapticFeedback provides object : HapticFeedback {
                    override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { types += hapticFeedbackType }
                },
            ) {
                StarbridgeTheme {
                    SwipeToSnooze(RoundedCornerShape(16.dp), onSwipe, Modifier.testTag("card")) { Box(Modifier.fillMaxWidth().height(96.dp)) }
                }
            }
        }
    }

    @Test fun swipeTicksAcrossTheThresholdBothWays() {
        card()
        val node = compose.onNodeWithTag("card")
        node.performTouchInput { down(centerLeft) }
        // Past 40% of the width, then back under it, slowly enough to let go without a fling.
        repeat(10) { node.performTouchInput { moveBy(Offset(width * 0.06f, 0f)) }; compose.mainClock.advanceTimeBy(50) }
        repeat(10) { node.performTouchInput { moveBy(Offset(-width * 0.05f, 0f)) }; compose.mainClock.advanceTimeBy(50) }
        compose.waitForIdle()
        node.performTouchInput { cancel() }
        compose.waitForIdle()
        assertEquals(listOf(HapticFeedbackType.GestureThresholdActivate), types)
        assertEquals(listOf(HapticFeedbackConstants.GESTURE_THRESHOLD_DEACTIVATE), played)
    }

    @Test fun snoozeIsNoBackOff() {
        var snoozed = 0
        card { snoozed++ }
        compose.onNodeWithTag("card").performTouchInput { swipeRight() }
        compose.waitForIdle()
        assertEquals(1, snoozed)
        assertEquals(listOf(HapticFeedbackType.GestureThresholdActivate), types)
        assertEquals(emptyList<Int>(), played)
    }
}

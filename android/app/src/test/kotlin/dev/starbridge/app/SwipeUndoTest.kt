package dev.starbridge.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.inbox.SwipeToSnooze
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A swiped card leaves the open list at once, as its snooze moves it under Snoozed; Undo brings
 * it back. Back, it must not snooze itself again (#1998), whatever its question changes next.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class SwipeUndoTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun aCardBroughtBackByUndoDoesNotSnoozeAgain() {
        var snoozes = 0
        var shown by mutableStateOf(true)
        // The question's waiting state, say: a change recomposes the card with a new lambda.
        var flips by mutableIntStateOf(0)
        compose.setContent {
            StarbridgeTheme {
                LazyColumn {
                    if (shown) item(key = "d_1") {
                        val flip = flips
                        SwipeToSnooze(RoundedCornerShape(16.dp), { snoozes++; shown = false; flip.hashCode() }, Modifier.testTag("card")) {
                            Box(Modifier.fillMaxWidth().height(96.dp))
                        }
                    }
                }
            }
        }
        compose.onNodeWithTag("card").performTouchInput { swipeRight() }
        compose.waitForIdle()
        assertEquals(1, snoozes)
        // Undo.
        shown = true
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(2_000)
        compose.waitForIdle()
        // The machine flips the question's waiting state.
        flips++
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(2_000)
        compose.waitForIdle()
        assertEquals(1, snoozes)
    }
}

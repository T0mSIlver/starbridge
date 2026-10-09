package dev.starbridge.app

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.performTouchInput
import dev.starbridge.app.ui.inbox.DecisionSheet
import dev.starbridge.app.ui.inbox.Replies
import dev.starbridge.app.ui.inbox.rememberDrafts
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

// A drag that starts on a question's image still moves its sheet, so no gesture of the image's
// own takes it (#246). `ScreenshotTest.imageViewer` covers the tap.
@OptIn(ExperimentalMaterial3Api::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class SheetDragTest {
    @get:Rule val compose = createComposeRule()
    private val now = Instant.parse("2026-10-04T14:00:00Z")

    private fun open() {
        val d = Fake(now).screenshot
        compose.setContent {
            StarbridgeTheme {
                ModalBottomSheet(onDismissRequest = {}, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                    Box(Modifier.testTag("sheet")) { DecisionSheet(d, now, { _, _, _ -> }, Replies(rememberDrafts())) }
                }
            }
        }
    }

    private val image get() = compose.onNodeWithContentDescription("Inbox, dark", useUnmergedTree = true)
    private fun top() = compose.onNodeWithTag("sheet", useUnmergedTree = true).getUnclippedBoundsInRoot().top.value

    // How far the sheet follows a finger that rests on [node], long enough to press it as a grab
    // does, then drags down; the sheet then settles back.
    private fun dragFrom(node: SemanticsNodeInteraction): Float {
        val start = top()
        node.performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(200)
        repeat(30) { node.performTouchInput { moveBy(Offset(0f, 12f)) } }
        compose.waitForIdle()
        val moved = top() - start
        node.performTouchInput { cancel() }
        compose.waitForIdle()
        return moved
    }

    @Test fun dragFromImageMovesSheetAsFromText() {
        open()
        val text = dragFrom(compose.onNodeWithText("Does this inbox screenshot look right?", useUnmergedTree = true))
        val image = dragFrom(image)
        assertTrue("from the text $text dp", text > 0f)
        assertEquals(text, image, 0.5f)
        compose.onNodeWithContentDescription("Close").assertDoesNotExist()
    }
}

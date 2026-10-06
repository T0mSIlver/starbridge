package dev.starbridge.app

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import dev.starbridge.app.data.InboxView
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

// A closed History waits at the bottom of a short inbox and rises under the items when opened
// (#662). The glide's frames land in build/history-glide/, for a look at the motion.
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class HistoryPlacementTest {
    @get:Rule val compose = createComposeRule()

    @Test fun closedHistoryWaitsAtTheBottomAndRisesWhenOpened() {
        val now = Instant.parse("2026-10-04T14:00:00Z")
        val answered = Fake(now).decisions.filterNot { it.isOpen }
        var view by mutableStateOf(InboxView())
        compose.setContent {
            StarbridgeTheme {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    InboxScreen(answered, now, DecisionActions({ _, _, _ -> }, {}), view = view, onView = { view = it })
                }
            }
        }
        val height = compose.onRoot().getBoundsInRoot().bottom
        val closed = compose.onNodeWithText("History").getBoundsInRoot().top
        assertTrue("closed History at the bottom: $closed of $height", closed > height * 0.75f)

        val frames = File("build/history-glide").apply { mkdirs() }
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("History").performClick()
        repeat(10) { i ->
            compose.mainClock.advanceTimeBy(40)
            val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
            File(frames, "frame-$i.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        val open = compose.onNodeWithText("History").getBoundsInRoot().top
        assertTrue("opened History under the items: $open, was $closed", open < height * 0.5f)
    }
}

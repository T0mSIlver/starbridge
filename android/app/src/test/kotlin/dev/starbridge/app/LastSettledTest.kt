package dev.starbridge.app

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Source
import dev.starbridge.app.ui.BottomSheetSceneStrategy
import dev.starbridge.app.ui.DecisionKey
import dev.starbridge.app.ui.InboxKey
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.QuestionSheet
import dev.starbridge.app.ui.inbox.Replies
import dev.starbridge.app.ui.inbox.onlyNeed
import dev.starbridge.app.ui.inbox.rememberDrafts
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * A question's sheet settled elsewhere while it shows (#1586): the last item that needed the owner
 * closes onto the empty inbox, as on web (#1583); with others still open, it stays to say how it closed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class LastSettledTest {
    @get:Rule val compose = createComposeRule()
    private val now = Instant.parse("2026-10-06T12:01:00Z")
    private val stack = mutableStateListOf<Any>(InboxKey, DecisionKey("d_ship"))
    private val decisions = mutableStateOf(listOf(question("d_ship", "Ship the release?")))

    private fun question(id: String, text: String) = Decision(
        id, text, "", listOf("Ship", "Hold"), "Ship", Source("mac", "starbridge", "s"), now.minusSeconds(60),
    )

    private fun withdraw(id: String) = compose.runOnUiThread {
        decisions.value = decisions.value.map { if (it.id == id) it.copy(answeredAt = now, settled = "withdrawn", reason = "Done by hand") else it }
    }

    private fun show() = compose.setContent {
        val sheets = remember { BottomSheetSceneStrategy<Any>() }
        StarbridgeTheme {
            NavDisplay(
                backStack = stack,
                onBack = { stack.removeAt(stack.lastIndex) },
                sceneStrategies = listOf(sheets),
                entryProvider = entryProvider {
                    entry<InboxKey> { InboxScreen(decisions.value, now, DecisionActions({ _, _, _ -> }, {})) }
                    entry<DecisionKey>(metadata = BottomSheetSceneStrategy.sheet) { key ->
                        val all = decisions.value
                        val d = all.first { it.id == key.id }
                        Box(Modifier.testTag("sheet")) {
                            QuestionSheet(d, now, { _, _, _ -> }, Replies(rememberDrafts()), onSnooze = {}, last = onlyNeed(d.id, all, emptyList(), now))
                        }
                    }
                },
            )
        }
    }

    private fun inSheet(text: String) = compose.onAllNodes(hasText(text, substring = true) and hasAnyAncestor(hasTestTag("sheet")))

    @Test
    fun theLastOneClosesOntoTheEmptyInbox() {
        show()
        inSheet("Ship the release?").fetchSemanticsNodes().let { check(it.isNotEmpty()) }
        withdraw("d_ship")
        compose.waitForIdle()
        compose.waitUntil(5_000) { stack.size == 1 }
        assertEquals(listOf<Any>(InboxKey), stack.toList())
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Nothing needs you")).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun withAnotherOpenItStaysSayingHowItClosed() {
        decisions.value += question("d_other", "Merge the docs?")
        show()
        withdraw("d_ship")
        compose.waitUntil(5_000) { inSheet("Done by hand").fetchSemanticsNodes().isNotEmpty() }
        compose.mainClock.advanceTimeBy(1_000)
        assertEquals(listOf<Any>(InboxKey, DecisionKey("d_ship")), stack.toList())
    }
}

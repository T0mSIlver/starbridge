package dev.starbridge.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.starbridge.app.ui.inbox.FindScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

// Find as the app hosts it: the results show as you type, on screen, and a tap opens one (#341).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class FindScreenTest {
    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)

    @Test fun typingFiltersTheResults() {
        val opened = mutableListOf<String>()
        compose.setContent { StarbridgeTheme { Entry { FindScreen(fake.decisions, fake.prompts, now, { opened += it }, {}, {}) } } }
        val field = compose.onNode(hasSetTextAction())
        val landing = "Which landing hero should I keep?"
        val merge = "Merge the server PR before the CLI PR?"

        field.performTextInput("starbridge")
        compose.onNodeWithText(landing).assertIsDisplayed()
        compose.onNodeWithText(merge).assertIsDisplayed()

        field.performTextInput(" landing")
        compose.onNodeWithText(landing).assertIsDisplayed()
        compose.onNodeWithText(merge).assertDoesNotExist()

        compose.onNodeWithText(landing).performClick()
        assertEquals(listOf(fake.decisions.single { it.question == landing }.id), opened)
    }
}

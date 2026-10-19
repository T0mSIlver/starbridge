package dev.starbridge.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import dev.starbridge.app.data.Phase
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The owner-token form: the keyboard's own key signs in, and a failure stays on the screen
 * under the fields rather than in a snackbar the keyboard hides (Play testers, 2026-10-19).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SignInFormTest {
    @get:Rule val compose = createComposeRule()

    private val signedIn = mutableListOf<Pair<String, String>>()
    private var dismissed = 0
    private val actions = SetupActions(
        gitHub = { "" }, apple = { "" }, ownerToken = { s, t -> signedIn += s to t }, firstDevice = {}, join = {},
        joinWithCode = {}, askDevices = {}, cancelJoin = {}, recover = {}, saved = {}, signOut = {},
        dismissError = { dismissed++ },
    )

    @Test fun theKeyboardsKeySignsIn() {
        compose.setContent { StarbridgeTheme { SetupScreen(Phase.SignedOut, "https://demo.example.com", false, actions, {}) } }
        compose.onNodeWithText("Owner token").performTextInput("secret")
        compose.onNodeWithText("Owner token").performImeAction()
        assertEquals(listOf("https://demo.example.com" to "secret"), signedIn)
    }

    @Test fun aFailureStaysUnderTheFieldsUntilTheOwnerTypes() {
        compose.setContent { StarbridgeTheme { SetupScreen(Phase.SignedOut, "https://demo.example.com", false, actions, {}, error = "Wrong owner token.") } }
        compose.onNodeWithText("Wrong owner token.").assertIsDisplayed()
        compose.onNodeWithText("Owner token").performTextInput("x")
        assertEquals(1, dismissed)
    }
}

package dev.starbridge.app

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.starbridge.app.data.Phase
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The recovery-key view offers Delete account, as the web's join page does (#1166).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RecoverDeleteTest {
    @get:Rule val compose = createComposeRule()

    @Test fun deleteAccountFromTheRecoveryKeyView() {
        val actions = SetupActions({ "" }, { _, _ -> }, {}, {}, {}, {}, {}, {}, {}, {})
        compose.setContent { StarbridgeTheme { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, actions, {}) } }
        compose.onNodeWithText("Use the recovery key").performClick()
        compose.onNodeWithText("Delete account").performClick()
        compose.onNodeWithText("Delete your account?").assertExists()
    }
}

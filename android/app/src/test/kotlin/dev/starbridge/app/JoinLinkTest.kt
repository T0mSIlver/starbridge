package dev.starbridge.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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

// A pairing link opened before this phone joins waits for the owner's tap.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class JoinLinkTest {
    @get:Rule val compose = createComposeRule()

    @Test fun aPairingLinkJoinsOnlyOnceTheOwnerSaysSo() {
        val link = "https://starbridge.run/pair#c=x"
        var offered by mutableStateOf<String?>(link)
        val joined = mutableListOf<String>()
        val actions = SetupActions({ "" }, { "" }, { _, _ -> }, {}, {}, { joined += it }, {}, {}, {}, {}, {}, dropJoinLink = { offered = null })
        compose.setContent { StarbridgeTheme { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, actions, {}, joinLink = offered) } }

        compose.onNodeWithText("Add this phone with this link?").assertExists()
        assertEquals(emptyList<String>(), joined)
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Add this phone with this link?").assertDoesNotExist()
        assertEquals(emptyList<String>(), joined)

        offered = link
        compose.onNodeWithText("Add this phone with this link?").assertExists()
        compose.onNode(hasText("Add this phone") and hasClickAction()).performClick()
        assertEquals(listOf(link), joined)
        compose.onNodeWithText("Add this phone with this link?").assertDoesNotExist()
    }
}

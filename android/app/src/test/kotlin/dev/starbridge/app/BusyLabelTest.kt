package dev.starbridge.app

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import dev.starbridge.app.ui.busyAs
import dev.starbridge.app.ui.setup.Primary
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A button that shows a spinner while it works keeps its name and says it is in progress (#1945). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BusyLabelTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun aBusyPrimaryButtonKeepsItsName() {
        compose.setContent { StarbridgeTheme { Primary("Sign in with GitHub", busy = true) {} } }
        compose.onNodeWithContentDescription("Sign in with GitHub")
            .assertIsNotEnabled()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "In progress"))
    }

    @Test
    fun anIdlePrimaryButtonStaysAsItWas() {
        compose.setContent { StarbridgeTheme { Primary("Sign in with GitHub", busy = false) {} } }
        compose.onNodeWithText("Sign in with GitHub")
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))
    }

    @Test
    fun busyAsNamesAnyButtonWithOnlyASpinner() {
        compose.setContent { Button(onClick = {}, modifier = Modifier.busyAs("Approve", true)) { Box {} } }
        compose.onNodeWithContentDescription("Approve")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "In progress"))
    }
}

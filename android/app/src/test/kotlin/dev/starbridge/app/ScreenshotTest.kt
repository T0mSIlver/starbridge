package dev.starbridge.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.Fake
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.setup.SetupStep
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

// Each screen on fake data, light and dark, rendered on the JVM. `recordRoborazziDebug`
// writes app/screenshots/; `verifyRoborazziDebug` fails when a screen drifts.
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun schemes() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))
    }

    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)

    private fun capture(name: String, content: @Composable () -> Unit) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
            }
        }
        compose.onRoot().captureRoboImage("screenshots/$name-${if (dark) "dark" else "light"}.png")
    }

    @Test fun inbox() = capture("inbox") { InboxScreen(fake.decisions, now, onAnswer = { _, _ -> }) }

    @Test fun quotas() = capture("quotas") { QuotasScreen(fake.windows, now) }

    @Test fun devices() = capture("devices") { DevicesScreen(fake.members, fake.pairings, now, DeviceActions({}, {}, {})) }

    @Test fun setupSignIn() = capture("setup-sign-in") { SetupScreen(SetupStep.SignIn, fake.recoveryWords, {}, {}) }

    @Test fun setupRecoveryKey() = capture("setup-recovery-key") { SetupScreen(SetupStep.RecoveryKey, fake.recoveryWords, {}, {}) }
}

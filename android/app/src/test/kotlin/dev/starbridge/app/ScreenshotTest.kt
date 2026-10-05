package dev.starbridge.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Phase
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.DecisionScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

// Each screen on fake data, light and dark, rendered on the JVM in DESIGN.md's palette (the
// "Starbridge" colours). `recordRoborazziDebug` writes app/screenshots/; `verifyRoborazziDebug` fails
// when a screen drifts.
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun schemes() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))

        // Clock times render in the phone's zone; one zone keeps CI and laptops alike.
        init {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        }
    }

    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)
    private val decisionActions = DecisionActions({ _, _, _ -> }, {})
    private val deviceActions = DeviceActions({}, {}, {}, {}, {}, {}, {})
    private val setupActions = SetupActions({ "" }, { _, _ -> }, {}, {}, {}, {}, {}, {})

    private fun capture(name: String, content: @Composable () -> Unit) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
            }
        }
        // Images decode off the main thread: let them land before the capture.
        compose.waitForIdle()
        Thread.sleep(300)
        compose.waitForIdle()
        // Images decode off the main thread: let them land before the capture.
        compose.waitForIdle()
        Thread.sleep(300)
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("screenshots/$name-${if (dark) "dark" else "light"}.png")
    }

    @Test fun inbox() = capture("inbox") { InboxScreen(fake.decisions, now, decisionActions) }

    // Text at 200% on the answered lines: who and when wrap below them.
    @Test fun inboxLargeText() = capture("inbox-large-text") {
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) {
            InboxScreen(fake.decisions.filterNot { it.isOpen(now) }, now, decisionActions)
        }
    }

    @Test fun decision() = capture("decision") { DecisionScreen(fake.decisions[1], now, onAnswer = { _, _, _ -> }) }

    @Test fun decisionImages() = capture("decision-images") { DecisionScreen(fake.decisions.first { it.images.isNotEmpty() }, now, onAnswer = { _, _, _ -> }) }

    @Test fun decisionAnswerIn() = capture("decision-answer-in") { DecisionScreen(fake.decisions.first { it.answerIn != null }, now, onAnswer = { _, _, _ -> }) }

    @Test fun quotas() = capture("quotas") { QuotasScreen(fake.windows, now) }

    @Test fun quotasEmpty() = capture("quotas-empty") { QuotasScreen(emptyList(), now) }

    @Test fun quotasStale() = capture("quotas-stale") { QuotasScreen(fake.staleWindows, now) }

    // Tall enough to show "This phone": notifications, colours and the server.
    @Config(qualifiers = "w411dp-h1500dp-xxhdpi")
    @Test fun devices() = capture("devices") { DevicesScreen(fake.members, Approval.Idle, fake.push, "https://starbridge.run", now, deviceActions) }

    @Test fun devicesPairing() = capture("devices-pairing") { DevicesScreen(fake.members, fake.approval, fake.push, "https://starbridge.run", now, deviceActions) }

    @Test fun setupSignIn() = capture("setup-sign-in") { SetupScreen(Phase.SignedOut, "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupFirstDevice() = capture("setup-first-device") { SetupScreen(Phase.NoDevice(accountExists = false), "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupJoin() = capture("setup-join") { SetupScreen(Phase.Joining("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupRecoveryKey() = capture("setup-recovery-key") { SetupScreen(Phase.RecoveryKey(fake.recoveryWords), "https://starbridge.run", false, setupActions, {}) }
}

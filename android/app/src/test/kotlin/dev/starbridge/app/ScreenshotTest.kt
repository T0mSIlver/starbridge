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
import dev.starbridge.app.data.Comparison
import dev.starbridge.app.data.JoinAsk
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.pairing.JoinActions
import dev.starbridge.app.ui.pairing.JoinPrompt
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.DecisionScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.ui.inbox.PromptLogScreen
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.ui.settings.SettingsActions
import dev.starbridge.app.ui.settings.SettingsScreen
import dev.starbridge.app.ui.devices.AddDeviceScreen
import dev.starbridge.app.ui.Tab
import dev.starbridge.app.data.Colours
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
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
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
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
    private val deviceActions = DeviceActions({}, {}, {}, {}, {})
    private val settingsActions = SettingsActions({}, {}, {}, {}, {}, {})
    private val setupActions = SetupActions({ "" }, { _, _ -> }, {}, {}, {}, {}, {}, {}, {}, {})

    private fun capture(name: String, before: () -> Unit = {}, content: @Composable () -> Unit) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
            }
        }
        before()
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

    @Test fun inboxPrompts() = capture("inbox-prompts") {
        InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = PromptActions({ _, _, _, _ -> }, {}))
    }

    @Test fun promptLog() = capture("prompt-log") { PromptLogScreen(fake.prompts, now) }

    // Taller: runs on top of the open decisions.
    @Config(qualifiers = "w411dp-h1500dp-xxhdpi")
    @Test fun inboxRuns() = capture("inbox-runs") { InboxScreen(fake.decisions, now, decisionActions, runs = fake.runs) }

    @Test fun decision() = capture("decision") { DecisionScreen(fake.decisions[1], now, onAnswer = { _, _, _ -> }) }

    @Test fun decisionImages() = capture("decision-images") { DecisionScreen(fake.decisions.first { it.images.isNotEmpty() }, now, onAnswer = { _, _, _ -> }) }

    @Test fun decisionAnswerIn() = capture("decision-answer-in") { DecisionScreen(fake.decisions.first { it.answerIn != null }, now, onAnswer = { _, _, _ -> }) }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    @Test fun quotas() = capture("quotas") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now) } }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    @Test fun quotasNotifying() = capture("quotas-notifying") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now, settings = QuotaSettings(notify = listOf("claude"))) } }

    // Remaining, clock times, a 5-day week with strong ticks, Codex first, Gemini hidden, Z.ai notifying.
    private val tuned = QuotaSettings(showUsed = false, absoluteResets = true, workDays = 5, ticks = QuotaSettings.Ticks.HighContrast, order = listOf("codex"), hidden = listOf("gemini"), notify = listOf("zai"))

    @Test fun quotasTuned() = capture("quotas-tuned") { QuotasScreen(fake.windows, now, settings = tuned) }

    // The mockup's settings, scrolled: the whole page.
    @Config(qualifiers = "w412dp-h1640dp-xxhdpi")
    @Test fun settings() = capture("settings") {
        Phone(Tab.Settings, 4) {
            SettingsScreen(fake.windows, QuotaSettings(hidden = listOf("gemini")), fake.members.size, Colours.Starbridge, fake.push, "https://starbridge.run", settingsActions)
        }
    }

    @Test fun quotasEmpty() = capture("quotas-empty") { QuotasScreen(emptyList(), now) }

    @Test fun quotasStale() = capture("quotas-stale") { QuotasScreen(fake.staleWindows, now) }

    @Test fun devices() = capture("devices") { Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions) } }

    @Test fun devicesRevoke() = capture("devices-revoke", before = { compose.onAllNodesWithText("Revoke")[0].performClick() }) {
        Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions) }
    }

    @Test fun addDevice() = capture("add-device") { Phone(null, 0) { AddDeviceScreen(Approval.Idle, deviceActions) } }

    @Test fun addDeviceFound() = capture("add-device-found") { Phone(null, 0) { AddDeviceScreen(fake.approval, deviceActions) } }

    @Test fun setupSignIn() = capture("setup-sign-in") { SetupScreen(Phase.SignedOut, "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupFirstDevice() = capture("setup-first-device") { SetupScreen(Phase.NoDevice(accountExists = false), "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupJoin() = capture("setup-join") { SetupScreen(Phase.Joining("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupJoinChoose() = capture("setup-join-choose") { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, setupActions, {}) }

    @Test fun setupJoinDigits() = capture("setup-join-digits") { SetupScreen(Phase.JoiningByDigits("042917"), "https://starbridge.run", false, setupActions, {}) }

    @Test fun addDeviceQr() = capture("add-device-qr") {
        Phone(null, 0) { AddDeviceScreen(Approval.Showing("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F", "https://starbridge.run/pair#7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), deviceActions) }
    }

    @Test fun joinDigits() = capture("join-digits") {
        val ask = JoinAsk("04106105", "Firefox on Linux", now, elsewhere = false)
        JoinPrompt(listOf(ask), Comparison.Digits(ask, "042917"), JoinActions({}, {}, {}, {}))
    }

    @Test fun joinDigitsRetry() = capture("join-digits-retry") {
        val ask = JoinAsk("04106105", "Firefox on Linux", now, elsewhere = false)
        val error = "Can't reach https://starbridge.run: timeout"
        JoinPrompt(listOf(ask), Comparison.Digits(ask, "042917", error = error), JoinActions({}, {}, {}, {}))
    }

    @Test fun setupRecoveryKey() = capture("setup-recovery-key") { SetupScreen(Phase.RecoveryKey(fake.recoveryWords), "https://starbridge.run", false, setupActions, {}) }
}

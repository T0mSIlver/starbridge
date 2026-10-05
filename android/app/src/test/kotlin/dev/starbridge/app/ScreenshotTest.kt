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
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.pairing.JoinActions
import dev.starbridge.app.ui.pairing.JoinPrompt
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.ui.settings.SettingsActions
import dev.starbridge.app.ui.settings.SettingsScreen
import dev.starbridge.app.ui.devices.AddDeviceScreen
import dev.starbridge.app.ui.Tab
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.InboxView
import dev.starbridge.app.data.Grouping
import dev.starbridge.app.data.CardButtons
import dev.starbridge.app.ui.since
import dev.starbridge.app.ui.inbox.rememberDrafts
import dev.starbridge.app.ui.inbox.Replies
import dev.starbridge.app.ui.inbox.PromptSheet
import dev.starbridge.app.ui.inbox.DecisionSheet
import dev.starbridge.app.data.Colours
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithContentDescription
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

    private val promptActions = PromptActions({ _, _, _, _ -> })
    @Composable
    private fun Inbox(view: InboxView = InboxView()) {
        InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs, view = view)
    }

    // The mockup's inbox: the run, the prompt, the question an agent waits on, then the others.
    @Test fun inbox() = capture("inbox") { Phone(Tab.Inbox, 4) { Inbox() } }

    @Config(qualifiers = "w412dp-h1400dp-xxhdpi")
    @Test fun inboxByMachine() = capture("inbox-by-machine") { Phone(Tab.Inbox, 4) { Inbox(InboxView(grouping = Grouping.Machine)) } }

    // What blocks an agent under "Waiting on you", the rest under "When you can" (#191).
    @Config(qualifiers = "w412dp-h1400dp-xxhdpi")
    @Test fun inboxByWaiting() = capture("inbox-by-waiting") { Phone(Tab.Inbox, 4) { Inbox(InboxView(grouping = Grouping.Waiting)) } }

    @Config(qualifiers = "w412dp-h1600dp-xxhdpi")
    @Test fun inboxHistory() = capture("inbox-history") { Phone(Tab.Inbox, 4) { Inbox(InboxView(historyOpen = true)) } }

    // Answer buttons only on the question the agent waits on (#138).
    @Test fun inboxButtonsWhenWaiting() = capture("inbox-buttons-when-waiting") { Phone(Tab.Inbox, 4) { Inbox(InboxView(buttons = CardButtons.WhenWaiting)) } }

    // A phone screenshot and a long option: the card crops the image to its top and stacks the
    // options, with the setting at Always (#170, #181).
    @Config(qualifiers = "w412dp-h1400dp-xxhdpi")
    @Test fun inboxImages() = capture("inbox-images") {
        Phone(Tab.Inbox, 2) { InboxScreen(listOf(fake.screenshot) + fake.decisions.filter { it.id == "d3" }, now, decisionActions) }
    }

    @Test fun inboxEmpty() = capture("inbox-empty") { Phone(Tab.Inbox, 0) { InboxScreen(fake.decisions.filterNot { it.isOpen(now) }, now, decisionActions, promptActions = promptActions) } }

    // Runs as they end, and text at 200%.
    @Test fun inboxEnded() = capture("inbox-ended") { Phone(Tab.Inbox, 0) { InboxScreen(emptyList(), now, decisionActions, runs = fake.endedRuns) } }

    // The indeterminate bar never settles: stop the clock mid-sweep.
    @Test fun inboxQuietRuns() = capture("inbox-quiet-runs", before = { compose.mainClock.autoAdvance = false; repeat(70) { compose.mainClock.advanceTimeByFrame() } }) { Phone(Tab.Inbox, 0) { InboxScreen(emptyList(), now, decisionActions, runs = fake.quietRuns) } }

    @Test fun inboxLargeText() = capture("inbox-large-text") {
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) { Phone(Tab.Inbox, 4) { Inbox() } }
    }

    // Sheets open over whatever page is up; the mockups show them over Quotas.
    @Composable
    private fun QuestionSheet(d: Decision) {
        Sheet({ QuotasScreen(fake.windows, now) }) { DecisionSheet(d, now, { _, _, _ -> }, Replies(rememberDrafts(), emptyMap())) }
    }

    @Test fun sheetQuestion() = capture("sheet-question") { QuestionSheet(fake.decisions.first { it.id == "d1" }) }

    @Test fun sheetWaiting() = capture("sheet-waiting") { QuestionSheet(fake.decisions.first { it.id == "d2" }) }

    @Test fun sheetPick() = capture("sheet-pick") { QuestionSheet(fake.decisions.first { it.id == "d3" }) }

    @Test fun sheetScreenshot() = capture("sheet-screenshot") { QuestionSheet(fake.screenshot) }

    // Full screen, opened from the sheet's image (#170).
    @Test fun imageViewer() = capture("image-viewer", before = { compose.onNodeWithContentDescription("Inbox, dark").performClick() }) { QuestionSheet(fake.screenshot) }

    @Test fun sheetAnswerIn() = capture("sheet-answer-in") { QuestionSheet(fake.answerIn) }

    @Test fun sheetFreeText() = capture("sheet-free-text") { QuestionSheet(fake.freeText) }

    @Test fun sheetAnswered() = capture("sheet-answered") { QuestionSheet(fake.decisions.first { it.id == "d4" }) }

    @Test fun sheetPrompt() = capture("sheet-prompt") {
        val p = fake.prompts.first()
        Sheet({ QuotasScreen(fake.windows, now) }) { PromptSheet(p, now, promptActions) }
    }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    @Test fun quotas() = capture("quotas") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now) } }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    // Running out first off: the order set holds, so the windows that run out stay in place.
    @Test fun quotasYourOrder() = capture("quotas-your-order") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now, settings = QuotaSettings(order = listOf("mistral", "codex"), runningOutFirst = false)) } }

    // Remaining, clock times, a 5-day week with strong ticks, Codex first, Gemini hidden.
    private val tuned = QuotaSettings(showUsed = false, absoluteResets = true, workDays = 5, ticks = QuotaSettings.Ticks.HighContrast, order = listOf("codex"), hidden = listOf("gemini"))

    @Test fun quotasTuned() = capture("quotas-tuned") { QuotasScreen(fake.windows, now, settings = tuned) }

    // The same, with the Clock setting on 12-hour.
    @Test fun quotasTuned12h() = capture("quotas-tuned-12h") { CompositionLocalProvider(LocalClock24 provides false) { QuotasScreen(fake.windows, now, settings = tuned) } }

    // The mockup's settings, scrolled: the whole page.
    @Config(qualifiers = "w412dp-h2400dp-xxhdpi")
    @Test fun settings() = capture("settings") {
        Phone(Tab.Settings, 4) {
            SettingsScreen(fake.windows, QuotaSettings(hidden = listOf("gemini"), notify = listOf("claude")), fake.members.size, Colours.Starbridge, fake.push, "https://starbridge.run", settingsActions)
        }
    }

    @Test fun quotasEmpty() = capture("quotas-empty") { QuotasScreen(emptyList(), now) }

    @Test fun quotasStale() = capture("quotas-stale") { QuotasScreen(fake.staleWindows, now) }

    @Test fun devices() = capture("devices") { Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions) } }

    @Test fun devicesRevoke() = capture("devices-revoke", before = { compose.onAllNodesWithText("Revoke")[0].performClick() }) {
        Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions) }
    }

    @Test fun addDevice() = capture("add-device") { Phone(null, 0) { AddDeviceScreen(Approval.Idle, deviceActions) } }

    @Test fun addDeviceJoined() = capture("add-device-joined") { Phone(null, 0) { AddDeviceScreen(Approval.Done("Chrome on Mac"), deviceActions) } }

    @Test fun setupRecover() = capture("setup-recover", before = {
        compose.onNodeWithText("Use the recovery key").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("7kq2 m9xd 4tpu")
    }) { Phone(null, 0) { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun addDeviceFound() = capture("add-device-found") { Phone(null, 0) { AddDeviceScreen(fake.approval, deviceActions) } }

    @Test fun setupSignIn() = capture("setup-sign-in") { Phone(null, 0) { SetupScreen(Phase.SignedOut, "https://starbridge.run", false, setupActions, {}) } }

    @Test fun setupFirstDevice() = capture("setup-first-device") { Phone(null, 0) { SetupScreen(Phase.NoDevice(accountExists = false), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun setupJoin() = capture("setup-join") { Phone(null, 0) { SetupScreen(Phase.Joining("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun setupJoinChoose() = capture("setup-join-choose") { Phone(null, 0) { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun setupJoinAsking() = capture("setup-join-asking") { Phone(null, 0) { SetupScreen(Phase.JoiningByDigits(null), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun setupSelfHosted() = capture("setup-self-hosted") { Phone(null, 0) { SetupScreen(Phase.SignedOut, "https://starbridge.example.com", false, setupActions, {}) } }

    @Test fun setupJoinDigits() = capture("setup-join-digits") { Phone(null, 0) { SetupScreen(Phase.JoiningByDigits("042917"), "https://starbridge.run", false, setupActions, {}) } }

    @Test fun addDeviceQr() = capture("add-device-qr") {
        Phone(null, 0) { AddDeviceScreen(Approval.Showing("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F", "https://starbridge.run/pair#7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), deviceActions) }
    }

    @Test fun joinDone() = capture("join-done") {
        JoinPrompt(emptyList(), Comparison.Done("Chrome on Mac joined."), JoinActions({}, {}, {}, {}))
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

    @Test fun setupRecoveryKey() = capture("setup-recovery-key") { Phone(null, 0) { SetupScreen(Phase.RecoveryKey(fake.recoveryKey), "https://starbridge.run", false, setupActions, {}) } }
}

package dev.starbridge.app

import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.devices.RecoveryKeyScreen
import dev.starbridge.app.ui.devices.RecoveryActions
import dev.starbridge.app.data.Replacing
import dev.starbridge.app.data.RecoveryNotice
import dev.starbridge.app.data.RecoveryUi
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
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
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
import dev.starbridge.app.ui.inbox.FindScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaAlerts
import dev.starbridge.app.ui.settings.SettingsActions
import dev.starbridge.app.ui.settings.AlertsScreen
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
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithContentDescription
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.setup.Installer
import dev.starbridge.app.ui.setup.UpdateRequired
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
    private val showcase = Showcase(now)
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

    /** The whole screen, popups and dialogs included, which [capture]'s root leaves out. */
    @OptIn(com.github.takahirom.roborazzi.ExperimentalRoborazziApi::class)
    private fun captureScreen(name: String, before: () -> Unit = {}, content: @Composable () -> Unit) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
            }
        }
        before()
        compose.waitForIdle()
        com.github.takahirom.roborazzi.captureScreenRoboImage("screenshots/$name-${if (dark) "dark" else "light"}.png")
    }

    private val promptActions = PromptActions({ _, _, _, _ -> })
    @Composable
    private fun Inbox(view: InboxView = InboxView()) {
        InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs, view = view)
    }

    // The mockup's inbox: the run, the prompt, the question an agent waits on, then the others.
    @Test fun inbox() = capture("inbox") { Phone(Tab.Inbox, 4) { Inbox() } }

    // Find over the inbox: open matches under "Needs you", answered ones under "History", the words marked.
    @Test fun find() = capture("find", { find("starbridge") }) { Phone(null, 0) { Entry { FindScreen(fake.decisions, fake.prompts, now, {}, {}, {}) } } }

    @Test fun findNothing() = capture("find-nothing", { find("kubernetes") }) { Phone(null, 0) { Entry { FindScreen(fake.decisions, fake.prompts, now, {}, {}, {}) } } }

    private fun find(query: String) = compose.onNode(hasSetTextAction()).performTextInput(query)

    // The landing page's hero phone: no prompt, so the question with images shows (#210).
    @Test fun inboxLanding() = capture("inbox-landing") { Phone(Tab.Inbox, 3) { InboxScreen(showcase.decisions, now, decisionActions, runs = showcase.runs) } }

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

    @Test fun inboxEmpty() = capture("inbox-empty") { Phone(Tab.Inbox, 0) { InboxScreen(fake.decisions.filterNot { it.isOpen }, now, decisionActions, promptActions = promptActions) } }

    // A new account before its first machine (#610).
    @Test fun inboxNoMachine() = capture("inbox-no-machine") { Phone(Tab.Inbox, 0) { InboxScreen(emptyList(), now, decisionActions, noMachine = true) } }

    // Runs as they end, and text at 200%.
    @Test fun inboxEnded() = capture("inbox-ended") { Phone(Tab.Inbox, 0) { InboxScreen(emptyList(), now, decisionActions, runs = fake.endedRuns, dismissRun = {}) } }

    // Runs closed (#835): the head still names the failed one.
    @Test fun inboxRunsClosed() = capture("inbox-runs-closed") { Phone(Tab.Inbox, 4) { InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs + fake.endedRuns, view = InboxView(runsOpen = false)) } }

    // The indeterminate bar never settles: stop the clock mid-sweep.
    @Test fun inboxQuietRuns() = capture("inbox-quiet-runs", before = { compose.mainClock.autoAdvance = false; repeat(70) { compose.mainClock.advanceTimeByFrame() } }) { Phone(Tab.Inbox, 0) { InboxScreen(emptyList(), now, decisionActions, runs = fake.quietRuns) } }

    @Test fun inboxLargeText() = capture("inbox-large-text") {
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) { Phone(Tab.Inbox, 4) { Inbox() } }
    }

    // Sheets open over whatever page is up; the mockups show them over Quotas.
    @Composable
    private fun QuestionSheet(d: Decision) {
        // As the app shows it: Snooze beside Reply on an open question (#571).
        Sheet({ QuotasScreen(fake.windows, now) }) { DecisionSheet(d, now, { _, _, _ -> }, Replies(rememberDrafts()), onSnooze = {}) }
    }

    @Test fun sheetQuestion() = capture("sheet-question") { QuestionSheet(fake.decisions.first { it.id == "d1" }) }

    @Test fun sheetWaiting() = capture("sheet-waiting") { QuestionSheet(fake.decisions.first { it.id == "d2" }) }

    // A reply typed under the options, in place of them (#201); the field is always open (#849).
    @Test fun sheetReply() = capture("sheet-reply", before = { compose.onNode(hasSetTextAction()).performTextInput("Only after the eval run") }) { QuestionSheet(fake.decisions.first { it.id == "d2" }) }

    // A long reply wraps beside the send button, never under it (#947).
    @Test fun sheetReplyLong() = capture("sheet-reply-long", before = { compose.onNode(hasSetTextAction()).performTextInput(LONG_REPLY) }) { QuestionSheet(fake.decisions.first { it.id == "d2" }) }

    @Test fun sheetPick() = capture("sheet-pick") { QuestionSheet(showcase.pick) }

    @Test fun sheetPickShapes() = capture("sheet-pick-shapes") { QuestionSheet(fake.layouts) }

    @Test fun sheetScreenshot() = capture("sheet-screenshot") { QuestionSheet(fake.screenshot) }

    // Full screen, opened from the sheet's image (#170).
    @Test fun imageViewer() = capture("image-viewer", before = { compose.onNodeWithContentDescription("Inbox, dark").performClick() }) { QuestionSheet(fake.screenshot) }

    @Test fun sheetAnswerIn() = capture("sheet-answer-in") { QuestionSheet(fake.answerIn) }

    // A question answered on its own page: the link and Done on its card (#539).
    @Test fun inboxAnswerIn() = capture("inbox-answer-in") {
        Phone(Tab.Inbox, 2) { InboxScreen(listOf(fake.answerIn, fake.answerIn.copy(id = "d6w", waiting = true, waitingSince = now.minusSeconds(95))), now, decisionActions) }
    }

    // Snoozing (#571): the Snoozed group open at the end of the inbox, the sheet's Snooze and its
    // times, straight on today's dial (#692), and a snoozed question's sheet.
    @Test fun inboxSnoozed() = capture("inbox-snoozed", before = { compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Snoozed")) }) {
        Phone(Tab.Inbox, 4) { InboxScreen(fake.decisions + fake.snoozed, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs, view = InboxView(snoozedOpen = true)) }
    }

    @Test fun inboxSnoozedClosed() = capture("inbox-snoozed-closed", before = { compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Snoozed")) }) {
        Phone(Tab.Inbox, 4) { InboxScreen(fake.decisions + fake.snoozed, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs) }
    }

    @Test fun sheetSnoozeMenu() = capture("sheet-snooze-menu", before = { compose.onNodeWithText("Snooze until 15:00").performScrollTo() }) {
        Sheet({ QuotasScreen(fake.windows, now) }) { DecisionSheet(fake.decisions.first { it.id == "d1" }, now, { _, _, _ -> }, Replies(rememberDrafts()), onSnooze = {}, snoozeOpen = true) }
    }

    @Test fun sheetSnoozed() = capture("sheet-snoozed") {
        Sheet({ QuotasScreen(fake.windows, now) }) { DecisionSheet(fake.snoozed[1], now, { _, _, _ -> }, Replies(rememberDrafts()), onSnooze = {}) }
    }

    // A question's card held past the swipe's threshold, to the right (#692).
    @Test fun inboxSwipe() = capture("inbox-swipe", before = {
        compose.onNodeWithText("Run speech inference", substring = true).performTouchInput {
            down(centerLeft)
            repeat(10) { moveBy(androidx.compose.ui.geometry.Offset(width * 0.06f, 0f)) }
        }
    }) {
        Phone(Tab.Inbox, 4) { Inbox() }
    }

    @Test fun sheetFreeText() = capture("sheet-free-text") { QuestionSheet(fake.freeText) }

    @Test fun sheetAnswered() = capture("sheet-answered") { QuestionSheet(fake.decisions.first { it.id == "d4" }) }

    @Test fun sheetPrompt() = capture("sheet-prompt") {
        val p = fake.prompts.first()
        Sheet({ QuotasScreen(fake.windows, now) }) { PromptSheet(p, now, promptActions) }
    }

    // The full input open, under its control: Allow and Deny stay where they were (#265).
    @Test fun sheetPromptInput() = capture("sheet-prompt-input", before = { compose.onNodeWithText("Full input").performClick() }) {
        val p = fake.prompts.first()
        Sheet({ QuotasScreen(fake.windows, now) }) { PromptSheet(p, now, promptActions) }
    }

    // A command past the 200-character summary shows whole, above Allow (#356).
    @Test fun sheetPromptLong() = capture("sheet-prompt-long") {
        Sheet({ QuotasScreen(fake.windows, now) }) { PromptSheet(fake.longPrompt, now, promptActions) }
    }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    @Test fun quotas() = capture("quotas") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now) } }

    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    // Running out first off: the order set holds, so the windows that run out stay in place.
    @Test fun quotasYourOrder() = capture("quotas-your-order") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now, settings = QuotaSettings(order = listOf("mistral", "codex"), runningOutFirst = false)) } }

    // Remaining, clock times, a 5-day week with strong ticks, Codex first, Gemini hidden.
    private val tuned = QuotaSettings(showUsed = false, absoluteResets = true, workDays = 5, order = listOf("codex"), hidden = listOf("gemini"))

    @Test fun quotasTuned() = capture("quotas-tuned") { QuotasScreen(fake.windows, now, settings = tuned) }

    // The same, with the Clock setting on 12-hour.
    @Test fun quotasTuned12h() = capture("quotas-tuned-12h") { CompositionLocalProvider(LocalClock24 provides false) { QuotasScreen(fake.windows, now, settings = tuned) } }

    // The mockup's settings, scrolled: the whole page.
    @Config(qualifiers = "w412dp-h2400dp-xxhdpi")
    @Test fun settings() = capture("settings") {
        Phone(Tab.Settings, 4) {
            SettingsScreen(fake.windows, QuotaSettings(hidden = listOf("gemini"), alerts = QuotaAlerts(windows = mapOf("claude/claude-5h" to emptyList(), "zai/zai-5h" to listOf("unused-headroom")))), fake.members.size, Colours.Starbridge, fake.push, "https://starbridge.run", settingsActions, pushHold = 30)
        }
    }

    // Settings → Alerts (#930): the column names once, a row per window of the providers shown.
    @Test fun settingsAlerts() = capture("settings-alerts") {
        Phone(Tab.Settings, 4) {
            AlertsScreen(fake.windows, QuotaSettings(hidden = listOf("gemini"), alerts = QuotaAlerts(windows = mapOf("zai/zai-5h" to listOf("unused-headroom")))), {}, {})
        }
    }

    // The same at font scale 1.3, where "Unused" once broke inside the word (#930).
    @Config(fontScale = 1.3f)
    @Test fun settingsAlertsLarge() = capture("settings-alerts-large") {
        Phone(Tab.Settings, 4) {
            AlertsScreen(fake.windows, QuotaSettings(hidden = listOf("gemini")), {}, {})
        }
    }

    // Notifications off (#342): a quiet line heads the inbox; Settings says so and can bring the line back once dismissed.
    @Test fun inboxNotificationsOff() = capture("inbox-notifications-off") { Phone(Tab.Inbox, 4) { InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs, notificationsOff = true) } }

    @Test fun settingsNotificationsOff() = capture("settings-notifications-off", { notifications() }) { Phone(Tab.Settings, 4) { NotificationsOffSettings(InboxView()) } }

    @Test fun settingsNotificationsOffDismissed() = capture("settings-notifications-off-dismissed", { notifications() }) { Phone(Tab.Settings, 4) { NotificationsOffSettings(InboxView(remindOff = false)) } }

    // The account's hold time (#848), under the notification rows.
    @Test fun settingsHold() = capture("settings-hold", { compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Hold while you’re at a screen")) }) {
        Phone(Tab.Settings, 4) {
            SettingsScreen(fake.windows, QuotaSettings(), fake.members.size, Colours.Starbridge, fake.push, "https://starbridge.run", settingsActions, pushHold = 30)
        }
    }

    @Composable
    private fun NotificationsOffSettings(inbox: InboxView) =
        SettingsScreen(fake.windows, QuotaSettings(), fake.members.size, Colours.Starbridge, fake.push, "https://starbridge.run", settingsActions, inbox = inbox, notificationsOff = true)

    private fun notifications() = compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Delivered through"))

    @Test fun quotasEmpty() = capture("quotas-empty") { QuotasScreen(emptyList(), now) }

    // A device that just joined (#661): the ask in flight, nothing came back, and no machine at all.
    @Test fun quotasLoading() = capture("quotas-loading") { QuotasScreen(emptyList(), now, refresh = Refresh(busy = true) {}, machines = listOf("devbox")) }
    @Test fun quotasNone() = capture("quotas-none") { QuotasScreen(emptyList(), now, machines = listOf("devbox", "laptop")) }
    @Test fun quotasNoMachine() = capture("quotas-no-machine") { QuotasScreen(emptyList(), now, machines = emptyList()) }

    @Test fun quotasStale() = capture("quotas-stale") { QuotasScreen(fake.staleWindows, now) }
    @Test fun quotasFailed() = capture("quotas-failed") { QuotasScreen(fake.failedWindows, now, failures = fake.failures) }

    // Each device's notifications as it last said (#943): read-only, since only a device changes its own.
    @Test fun devices() = capture("devices") { Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions, notify = mapOf("m1" to "on", "m2" to "off", "m3" to "blocked")) } }

    // The recovery key under the members (#348): when and where it was set, with Replace.
    private val recovery = RecoveryUi(now.minusSeconds(86_400 * 2), "this phone", replaced = false)
    @Test fun devicesRecovery() = capture("devices-recovery") { Phone(null, 0) { DevicesScreen(fake.members, now, deviceActions, recovery = recovery) } }

    private val recoveryActions = RecoveryActions({}, {}, {})
    @Test fun recoveryKeyAsk() = capture("recovery-key-ask") { Phone(null, 0) { RecoveryKeyScreen(Replacing.Idle, busy = false, actions = recoveryActions) } }
    @Test fun recoveryKeyShown() = capture("recovery-key-shown") {
        Phone(null, 0) { RecoveryKeyScreen(Replacing.Shown("7K2M-QX9D-T4HR-8VNC-W3JP-F6BZ-0E5A"), busy = false, actions = recoveryActions) }
    }
    // Copy says the clipboard clears itself (#817).
    @Test fun recoveryKeyCopied() = capture("recovery-key-copied", before = { compose.onNodeWithText("Copy").performScrollTo().performClick() }) {
        Phone(null, 0) { RecoveryKeyScreen(Replacing.Shown("7K2M-QX9D-T4HR-8VNC-W3JP-F6BZ-0E5A"), busy = false, actions = recoveryActions) }
    }
    @Test fun recoveryKeyDone() = capture("recovery-key-done") { Phone(null, 0) { RecoveryKeyScreen(Replacing.Done, busy = false, actions = recoveryActions) } }

    // Every other device says once that the key was replaced.
    @Test fun inboxRecoveryNotice() = capture("inbox-recovery-notice") {
        Phone(Tab.Inbox, 4) {
            InboxScreen(fake.decisions, now, decisionActions, prompts = fake.prompts, promptActions = promptActions, runs = fake.runs,
                recovery = recovery.copy(replaced = true, setBy = "Firefox on Linux", notice = RecoveryNotice(9, now.minusSeconds(600), "Firefox on Linux")))
        }
    }

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

    @Test fun updateRequiredPlay() = capture("update-required-play") { Phone(null, 0) { UpdateRequired("1.2.0", "1.0.3", Installer.Play, update = {}) } }

    @Test fun updateRequiredObtainium() = capture("update-required-obtainium") { Phone(null, 0) { UpdateRequired("1.2.0", "1.0.3", Installer.Obtainium, update = {}) } }

    @Test fun updateRequiredRelease() = capture("update-required-release") { Phone(null, 0) { UpdateRequired("1.2.0", "1.0.3", Installer.Other, update = {}) } }

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

private const val LONG_REPLY =
    "Not quite. Keep the API change first, but split the migration into its own PR so the checkout one stays reviewable, and before you merge anything rerun the full test suite against staging with the new routes, then show me the diff of api/orders.ts and the two failing snapshots you mentioned yesterday so I can decide whether to update them or fix the rendering."

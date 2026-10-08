package dev.starbridge.app

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.WideNavigationRailDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.RoborazziTaskType
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Comparison
import dev.starbridge.app.data.Grouping
import dev.starbridge.app.data.InboxView
import dev.starbridge.app.data.JoinAsk
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.ui.BottomBar
import dev.starbridge.app.ui.LocalSheetGround
import dev.starbridge.app.ui.SheetGround
import dev.starbridge.app.ui.SheetHandle
import dev.starbridge.app.ui.SheetShape
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.Tab
import dev.starbridge.app.ui.suiteType
import dev.starbridge.app.ui.TabLabel
import dev.starbridge.app.ui.devices.AddDeviceScreen
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.DecisionSheet
import dev.starbridge.app.ui.inbox.FindScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.ui.inbox.PromptSheet
import dev.starbridge.app.ui.inbox.Replies
import dev.starbridge.app.ui.inbox.rememberDrafts
import dev.starbridge.app.ui.pairing.JoinActions
import dev.starbridge.app.ui.pairing.JoinPrompt
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.settings.SettingsActions
import dev.starbridge.app.ui.settings.SettingsScreen
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

/**
 * Every screen on the longest content, at phone, foldable and landscape sizes and font scales from
 * 0.85 to 2, in the app's own frame with system bars and a landscape cutout. Fails when text is
 * cut off, text overlaps text, or a tap target is under 48 dp (#306).
 *
 * CI runs the extremes. `STARBRIDGE_AUDIT=<dir>` runs every size, scale and colour scheme and
 * writes each shot and a report there, for a person to look at.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp-xhdpi")
class LayoutAuditTest(private val shot: String, private val look: Look) {
    data class Size(val name: String, val w: Int, val h: Int) {
        val land get() = w > h
        override fun toString() = name
    }

    /** One rendering: a window size, a font scale and a colour scheme. */
    data class Look(val size: Size, val font: Float, val dark: Boolean = false, val wallpaper: Wallpaper? = null) {
        override fun toString() = "$size@${font}x" + (if (dark) "-dark" else "") + (wallpaper?.let { "-${it.name.lowercase()}" } ?: "")
    }

    companion object {
        val audit: File? = System.getenv("STARBRIDGE_AUDIT")?.let(::File)

        private val small = Size("320x640", 320, 640)
        private val pixel = Size("412x915", 412, 915)
        private val land = Size("915x412", 915, 412)
        private val sizes = listOf(small, Size("360x800", 360, 800), pixel, Size("600x960", 600, 960), land)
        private val fonts = listOf(0.85f, 1f, 1.3f, 2f)

        private fun looks(): List<Look> = if (audit == null) {
            listOf(Look(small, 2f), Look(land, 1.3f), Look(pixel, 1f))
        } else {
            sizes.flatMap { s -> fonts.map { Look(s, it) } } +
                listOf(1f, 2f).map { Look(pixel, it, dark = true) } +
                Wallpaper.entries.flatMap { w -> listOf(false, true).map { Look(pixel, 1f, it, w) } }
        }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0} {1}")
        fun cases() = SHOTS.flatMap { s -> looks().map { arrayOf<Any>(s, it) } }

        val SHOTS = listOf(
            "setup-sign-in", "setup-first-device", "setup-join-choose", "setup-join", "setup-join-digits", "setup-recover", "setup-recovery-key",
            "inbox", "inbox-empty", "inbox-by-machine", "inbox-by-waiting", "inbox-history", "inbox-runs", "inbox-view-menu", "inbox-prompt-menu",
            "find", "sheet-question", "sheet-reply", "sheet-prompt", "sheet-prompt-input", "sheet-images", "image-viewer",
            "quotas", "quotas-your-order", "quotas-tuned",
            "settings", "devices", "devices-revoke", "add-device", "add-device-found", "add-device-qr", "join-digits",
        )

        private val REFERENCES = setOf(
            "inbox 320x640@2.0x", "quotas 320x640@2.0x", "settings 320x640@2.0x", "setup-join-digits 320x640@2.0x",
            "sheet-question 320x640@2.0x", "inbox 915x412@1.3x", "sheet-prompt 915x412@1.3x",
        )

        init {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        }
    }

    // The window's size and font scale apply before the activity starts.
    private val window = TestRule { base, _ ->
        object : org.junit.runners.model.Statement() {
            override fun evaluate() {
                val s = look.size
                RuntimeEnvironment.setQualifiers("w${s.w}dp-h${s.h}dp-${if (s.land) "land" else "port"}-xhdpi")
                RuntimeEnvironment.setFontScale(look.font)
                base.evaluate()
            }
        }
    }
    private val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(window).around(compose)

    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)
    private val worst = Worst(now)
    private val decisionActions = DecisionActions({ _, _, _ -> }, {})
    private val promptActions = PromptActions({ _, _, _, _ -> })
    private val deviceActions = DeviceActions({}, {}, {}, {}, {})
    private val settingsActions = SettingsActions({}, {}, {}, {}, {}, {})
    private val setupActions = SetupActions({ "" }, { _, _ -> }, {}, {}, {}, {}, {}, {}, {}, {})

    private class Shot(val tab: Tab?, val bar: Boolean = true, val before: () -> Unit = {}, val content: @Composable () -> Unit)

    @Composable
    private fun Inbox(view: InboxView = InboxView()) =
        InboxScreen(worst.decisions, now, decisionActions, prompts = worst.prompts, promptActions = promptActions, runs = worst.runs, view = view)

    private fun setup(phase: Phase, server: String = worst.server) = Shot(null) { SetupScreen(phase, server, false, setupActions, {}) }

    private val shots: Map<String, Shot> = mapOf(
        "setup-sign-in" to setup(Phase.SignedOut),
        "setup-first-device" to setup(Phase.NoDevice(accountExists = false)),
        "setup-join-choose" to setup(Phase.NoDevice(accountExists = true)),
        "setup-join" to setup(Phase.Joining("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F")),
        "setup-join-digits" to setup(Phase.JoiningByDigits("042917")),
        "setup-recover" to Shot(null, before = {
            compose.onNodeWithText("Use the recovery key").performScrollTo().performClick()
            compose.onNode(hasSetTextAction()).performScrollTo().performTextInput("7kq2 m9xd 4tpu hb3n r8ce wy6f j2qa")
        }) { SetupScreen(Phase.NoDevice(accountExists = true), worst.server, false, setupActions, {}) },
        "setup-recovery-key" to setup(Phase.RecoveryKey(fake.recoveryKey)),
        "inbox" to Shot(Tab.Inbox) { Inbox() },
        "inbox-empty" to Shot(Tab.Inbox) { InboxScreen(emptyList(), now, decisionActions, promptActions = promptActions) },
        "inbox-by-machine" to Shot(Tab.Inbox) { Inbox(InboxView(grouping = Grouping.Machine)) },
        "inbox-by-waiting" to Shot(Tab.Inbox) { Inbox(InboxView(grouping = Grouping.Waiting)) },
        "inbox-history" to Shot(Tab.Inbox) { InboxScreen(worst.decisions.filter { it.answer != null }, now, decisionActions, view = InboxView(historyOpen = true)) },
        "inbox-runs" to Shot(Tab.Inbox) { InboxScreen(worst.decisions.take(1), now, decisionActions, runs = worst.runs + fake.endedRuns) },
        "inbox-view-menu" to Shot(Tab.Inbox, before = { compose.onNodeWithContentDescription("View").performClick() }) { Inbox() },
        "inbox-prompt-menu" to Shot(Tab.Inbox, before = { compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("More answers")))[0].performScrollTo().performClick() }) {
            InboxScreen(emptyList(), now, decisionActions, prompts = worst.prompts, promptActions = promptActions)
        },
        "find" to Shot(Tab.Inbox, bar = false, before = { compose.onNode(hasSetTextAction()).performTextInput("rebase") }) { Entry { FindScreen(worst.decisions, worst.prompts, now, {}, {}, {}) } },
        "sheet-question" to sheet { DecisionSheet(worst.decisions[0], now, { _, _, _ -> }, Replies(rememberDrafts(), emptyMap())) },
        "sheet-reply" to sheet(before = { compose.onNode(hasSetTextAction()).performTextInput("Only after the eval run") }) { DecisionSheet(worst.decisions[1], now, { _, _, _ -> }, Replies(rememberDrafts(), emptyMap())) },
        "sheet-prompt" to sheet { PromptSheet(worst.prompts[0], now, promptActions) },
        "sheet-prompt-input" to sheet(before = { compose.onNodeWithText("Full input").performClick() }) { PromptSheet(worst.prompts[0], now, promptActions) },
        "sheet-images" to sheet { DecisionSheet(fake.screenshot.copy(source = worst.decisions[0].source, options = worst.decisions[0].options), now, { _, _, _ -> }, Replies(rememberDrafts(), emptyMap())) },
        "image-viewer" to sheet(before = { compose.onNodeWithContentDescription("Inbox, dark").performClick() }) { DecisionSheet(fake.screenshot, now, { _, _, _ -> }, Replies(rememberDrafts(), emptyMap())) },
        "quotas" to Shot(Tab.Quotas) { QuotasScreen(worst.windows, now) },
        "quotas-your-order" to Shot(Tab.Quotas) { QuotasScreen(worst.windows, now, settings = QuotaSettings(order = listOf("mistral", "codex"), runningOutFirst = false)) },
        "quotas-tuned" to Shot(Tab.Quotas) {
            CompositionLocalProvider(dev.starbridge.app.ui.LocalClock24 provides false) {
                QuotasScreen(worst.windows, now, settings = QuotaSettings(showUsed = false, absoluteResets = true, workDays = 5, ticks = QuotaSettings.Ticks.HighContrast))
            }
        },
        "settings" to Shot(Tab.Settings) {
            SettingsScreen(worst.windows, QuotaSettings(notify = listOf("claude")), worst.members.size, Colours.Starbridge, fake.push, worst.server, settingsActions, pushHold = 120)
        },
        "devices" to Shot(Tab.Settings, bar = false) { DevicesScreen(worst.members, now, deviceActions) },
        "devices-revoke" to Shot(Tab.Settings, bar = false, before = { compose.onAllNodesWithText("Revoke")[0].performClick() }) { DevicesScreen(worst.members, now, deviceActions) },
        "add-device" to Shot(Tab.Settings, bar = false) { AddDeviceScreen(Approval.Idle, deviceActions) },
        "add-device-found" to Shot(Tab.Settings, bar = false) { AddDeviceScreen(worst.approval, deviceActions) },
        "add-device-qr" to Shot(Tab.Settings, bar = false) {
            AddDeviceScreen(Approval.Showing("7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F", "https://starbridge.run/pair#7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F"), deviceActions)
        },
        "join-digits" to Shot(Tab.Inbox) {
            Inbox()
            val ask = JoinAsk("04106105", "Chrome on build-runner-eu-central-mac-studio-2 (self-hosted CI)", now, elsewhere = false)
            JoinPrompt(listOf(ask), Comparison.Digits(ask, "042917", error = "Can't reach ${worst.server}: connection timed out after 30 seconds"), JoinActions({}, {}, {}, {}))
        },
    )

    /** A sheet over the inbox, as Material's modal sheet in its own window, like the app's. */
    @OptIn(ExperimentalMaterial3Api::class)
    private fun sheet(before: () -> Unit = {}, content: @Composable () -> Unit) = Shot(Tab.Inbox, before = before) {
        Inbox()
        val ground = remember { SheetGround() }
        ModalBottomSheet(
            onDismissRequest = {},
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            shape = SheetShape,
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            scrimColor = StarbridgeTheme.colors.scrim,
            dragHandle = { SheetHandle(ground.color) },
        ) { CompositionLocalProvider(LocalSheetGround provides ground) { content() } }
    }

    /** The app's frame from `Root.kt`: the navigation suite for the window, the bottom bar on phones. */
    @Composable
    private fun Frame(shot: Shot) {
        if (shot.tab == null) {
            Scaffold { padding -> androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(padding)) { shot.content() } }
            return
        }
        val suite = suiteType()
        val colors = StarbridgeTheme.colors
        NavigationSuiteScaffold(
            navigationSuiteType = suite,
            navigationSuiteColors = NavigationSuiteDefaults.colors(
                shortNavigationBarContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                wideNavigationRailColors = WideNavigationRailDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            ),
            containerColor = MaterialTheme.colorScheme.surface,
            navigationItems = {
                for (tab in Tab.entries) {
                    NavigationSuiteItem(
                        navigationSuiteType = suite,
                        selected = shot.tab == tab,
                        onClick = {},
                        icon = { BadgedBox(badge = { if (tab == Tab.Inbox) Badge(containerColor = colors.accent, contentColor = colors.onAccent) { Text("12") } }) { Symbol(tab.sym, filled = shot.tab == tab) } },
                        label = { TabLabel(tab) },
                    )
                }
            },
        ) {
            Scaffold(
                bottomBar = { if (suite == NavigationSuiteType.None && shot.bar) BottomBar(shot.tab, 12, {}) },
                containerColor = MaterialTheme.colorScheme.surface,
            ) { padding -> androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(padding)) { shot.content() } }
        }
    }

    private var shotFile: File? = null

    @Test fun layout() {
        val shot = shots.getValue(this.shot)
        compose.setContent {
            val scheme = look.wallpaper?.scheme(look.dark)
            StarbridgeTheme(darkTheme = look.dark, colours = if (scheme != null) Colours.Wallpaper else Colours.Starbridge, dynamic = scheme) { Frame(shot) }
        }
        bars()
        compose.waitForIdle()
        shot.before()
        // Images decode off the main thread: let them land.
        compose.waitForIdle()
        if ("image" in this.shot) {
            Thread.sleep(300)
            compose.waitForIdle()
        }
        val problems = check()
        audit?.let { dir ->
            val name = "${this.shot}-$look"
            File(dir, "shots").mkdirs()
            shotFile = File(dir, "shots/$name.png")
            captureScreenRoboImage(shotFile!!.path, roborazziOptions = RoborazziOptions(taskType = RoborazziTaskType.Record))
            val notes = problems.map { "FAIL $it" } + notes()
            if (notes.isNotEmpty()) File(dir, "report").apply { mkdirs() }.resolve("$name.txt").writeText(notes.joinToString("\n", postfix = "\n"))
        }
        // The worst cases as reference shots, which `verifyRoborazziDebug` holds to.
        if (audit == null && "${this.shot} $look" in REFERENCES) captureScreenRoboImage("screenshots/audit/${this.shot}-$look.png")
        if (audit == null) assertTrue("${this.shot} $look:\n" + problems.joinToString("\n"), problems.isEmpty())
    }

    /** Status and gesture bars, and in landscape the camera cutout on the left, as a Pixel has them. */
    private fun bars() {
        val d = compose.activity.resources.displayMetrics.density
        fun px(dp: Int) = (dp * d).toInt()
        val bars = if (look.size.land) Insets.of(0, px(24), 0, px(24)) else Insets.of(0, px(36), 0, px(24))
        val cutout = if (look.size.land) Insets.of(px(36), 0, 0, 0) else Insets.of(0, px(36), 0, 0)
        val insets = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, bars.top, 0, 0))
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, bars.bottom))
            .setInsets(WindowInsetsCompat.Type.displayCutout(), cutout)
            .build()
        compose.runOnUiThread { ViewCompat.dispatchApplyWindowInsets(compose.activity.window.decorView, insets) }
    }

    private fun nodes(matcher: SemanticsMatcher, unmerged: Boolean) = compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes(atLeastOneRootRequired = false)

    private val texts get() = nodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), unmerged = true)
        .filter { it.boundsInRoot.width > 0 && it.boundsInRoot.height > 0 && label(it).isNotBlank() }

    private fun label(n: SemanticsNode) = n.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ").orEmpty().filterNot(::isGlyph)

    private fun isGlyph(c: Char) = c in '\uE000'..'\uF8FF'

    private fun SemanticsNode.unclipped() = Rect(positionInRoot, size.toSize())
    private fun androidx.compose.ui.unit.IntSize.toSize() = androidx.compose.ui.geometry.Size(width.toFloat(), height.toFloat())

    private fun SemanticsNode.inScroll(horizontal: Boolean): Boolean {
        var p = parent
        while (p != null) {
            if (p.config.contains(if (horizontal) SemanticsProperties.HorizontalScrollAxisRange else SemanticsProperties.VerticalScrollAxisRange)) return true
            p = p.parent
        }
        return false
    }

    private fun SemanticsNode.disabled(): Boolean {
        var p: SemanticsNode? = this
        while (p != null) {
            if (p.config.contains(SemanticsProperties.Disabled)) return true
            p = p.parent
        }
        return false
    }

    private fun SemanticsNode.isAncestorOf(other: SemanticsNode): Boolean {
        var p = other.parent
        while (p != null) {
            if (p.id == id) return true
            p = p.parent
        }
        return false
    }

    private fun layout(n: SemanticsNode): TextLayoutResult? {
        val out = mutableListOf<TextLayoutResult>()
        n.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(out)
        return out.firstOrNull()
    }

    private val density get() = compose.activity.resources.displayMetrics.density

    /** What fails: text cut off at its sides or inside its box, text over text, small tap targets. */
    private fun check(): List<String> {
        val out = mutableListOf<String>()
        val texts = texts
        for (n in texts) {
            val u = n.unclipped()
            val c = n.boundsInRoot
            val name = "\"${label(n).take(60)}\""
            // A vertical list cuts its rows at its ends as it scrolls, never at their sides.
            if ((c.left > u.left + 1 || c.right < u.right - 1) && !n.inScroll(horizontal = true)) out += "cut at the side: $name (${u.width.toInt()} px wide, ${c.width.toInt()} shown)"
            if ((c.top > u.top + 1 || c.bottom < u.bottom - 1) && !n.inScroll(horizontal = false)) out += "cut at the top or bottom: $name"
            val l = layout(n)
            if (l == null) continue
            val widest = (0 until l.lineCount).maxOfOrNull { l.getLineRight(it) - l.getLineLeft(it) } ?: 0f
            if (widest > l.size.width + 2) out += "wider than its box: $name"
            val ellipsized = (0 until l.lineCount).any { l.isLineEllipsized(it) }
            // A short word split across lines ("Setting" over "s"); long names and commands may break anywhere.
            val text = l.layoutInput.text.text
            if (text.length <= 15 && ' ' !in text && l.lineCount > 1) out += "word broken: $name"
            // The size tells a page title from a tab label with the same words.
            if (l.multiParagraph.didExceedMaxLines && !ellipsized) out += "lines cut off: $name (${l.layoutInput.style.fontSize.value.toInt()} sp)"
            else if (l.lineCount > 0) {
                val last = l.lineCount - 1
                // A figure pinned to its line height overflows it by a fifth: a quarter cuts the glyphs.
                val excess = l.getLineBottom(last) - l.size.height
                val line = l.getLineBottom(last) - l.getLineTop(last)
                if (excess > line / 4) out += "taller than its box: $name (${excess.toInt()} px of a ${line.toInt()} px line)"
            }
        }
        for (i in texts.indices) for (j in i + 1 until texts.size) {
            val a = texts[i]
            val b = texts[j]
            if (a.root != b.root || a.isAncestorOf(b) || b.isAncestorOf(a)) continue
            val o = a.boundsInRoot.intersect(b.boundsInRoot)
            // Glyphs may reach past their line box (a title pinned to its line height): count a
            // real overlap, a third of the smaller text.
            val small = minOf(a.boundsInRoot.height, b.boundsInRoot.height)
            if (o.width > 2 && o.height > small / 3) out += "text over text: \"${label(a).take(40)}\" and \"${label(b).take(40)}\""
        }
        out += tapTargets()
        return out.distinct()
    }

    /**
     * Tap areas under 48 dp. Compose widens a control's touch area to 48 dp where nothing else is
     * (`ViewConfiguration.minimumTouchTargetSize`), and Material pads some controls to 48 dp in
     * layout. So a control's area is its box grown to 48 dp each way, stopped at the window's edge,
     * at the card around it, at a neighbour's box, and halfway to a neighbour that grows towards it
     * too. A control over another (a sheet's handle over the scrim) grows only within what lies
     * over that one, the sheet: past it, a direct hit on the one under wins.
     */
    private fun tapTargets(): List<String> {
        val min = 48 * density
        // Controls cut by a scrolling list's end are judged where they show in full.
        val clicks = nodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick), unmerged = false)
            .filter { it.layoutInfo.isPlaced && !it.boundsInRoot.isEmpty && it.boundsInRoot == it.unclipped() }
        fun box(n: SemanticsNode): Rect {
            val u = n.unclipped()
            val dx = maxOf(0f, n.layoutInfo.width - u.width) / 2
            val dy = maxOf(0f, n.layoutInfo.height - u.height) / 2
            return Rect(u.left - dx, u.top - dy, u.right + dx, u.bottom + dy)
        }
        fun grow(size: Float) = maxOf(0f, (min - size) / 2)
        val out = mutableListOf<String>()
        for (n in clicks) {
            val b = box(n)
            var root = n
            while (root.parent != null) root = root.parent!!
            var bounds = Rect(0f, 0f, root.size.width.toFloat(), root.size.height.toFloat())
            if (b.intersect(bounds) != b) continue
            // A card (a clickable surface) clips what it holds, touch included.
            var p = n.parent
            var layer = n
            while (p != null) {
                if (p.config.contains(SemanticsActions.OnClick)) bounds = bounds.intersect(p.unclipped())
                if (p.parent != null) layer = p
                p = p.parent
            }
            val grown = Rect(b.left - grow(b.width), b.top - grow(b.height), b.right + grow(b.width), b.bottom + grow(b.height))
            var left = maxOf(bounds.left, grown.left)
            var right = minOf(bounds.right, grown.right)
            var top = maxOf(bounds.top, grown.top)
            var bottom = minOf(bounds.bottom, grown.bottom)
            for (m in clicks) {
                if (m === n || m.root !== n.root || m.isAncestorOf(n) || n.isAncestorOf(m)) continue
                val o = box(m)
                if (o.overlaps(b)) {
                    val over = layer.boundsInRoot
                    left = maxOf(left, over.left)
                    right = minOf(right, over.right)
                    top = maxOf(top, over.top)
                    bottom = minOf(bottom, over.bottom)
                    continue
                }
                if (o.left < grown.right && o.right > grown.left) {
                    if (o.top >= b.bottom) bottom = minOf(bottom, o.top, maxOf((b.bottom + o.top) / 2, o.top - grow(o.height)))
                    if (o.bottom <= b.top) top = maxOf(top, o.bottom, minOf((b.top + o.bottom) / 2, o.bottom + grow(o.height)))
                }
                if (o.top < grown.bottom && o.bottom > grown.top) {
                    if (o.left >= b.right) right = minOf(right, o.left, maxOf((b.right + o.left) / 2, o.left - grow(o.width)))
                    if (o.right <= b.left) left = maxOf(left, o.right, minOf((b.left + o.right) / 2, o.right + grow(o.width)))
                }
            }
            if (right - left < min - 1 || bottom - top < min - 1) {
                val what = label(n).ifBlank { n.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString().orEmpty() }
                out += "tap target ${((right - left) / density).toInt()}x${((bottom - top) / density).toInt()} dp: \"${what.take(50)}\""
            }
        }
        return out
    }

    /** For a person to judge: ellipsized text, and text whose contrast reads under WCAG AA. */
    private fun notes(): List<String> {
        val out = mutableListOf<String>()
        val texts = texts
        for (n in texts) {
            val l = layout(n) ?: continue
            if ((0 until l.lineCount).any { l.isLineEllipsized(it) }) out += "ellipsized: \"${label(n).take(80)}\""
        }
        // Contrast on the screen as shown, for the top window's text: the commonest colour in the
        // text's box is its ground, the farthest from it its ink.
        val screen = android.graphics.BitmapFactory.decodeFile(shotFile!!.path)
        val top = texts.lastOrNull()?.root ?: return out
        // Disabled controls are exempt (WCAG 1.4.3).
        for (n in texts.filter { it.root === top && !it.disabled() }) {
            val at = IntArray(2).also { (top as androidx.compose.ui.platform.ViewRootForTest).view.getLocationOnScreen(it) }
            val b = n.boundsInRoot.translate(at[0].toFloat(), at[1].toFloat())
            val x0 = b.left.toInt().coerceIn(0, screen.width - 1)
            val x1 = b.right.toInt().coerceIn(x0 + 1, screen.width)
            val y0 = b.top.toInt().coerceIn(0, screen.height - 1)
            val y1 = b.bottom.toInt().coerceIn(y0 + 1, screen.height)
            val counts = HashMap<Int, Int>()
            for (y in y0 until y1) for (x in x0 until x1) counts.merge(screen.getPixel(x, y), 1, Int::plus)
            val ground = Color(counts.maxBy { it.value }.key)
            val ink = counts.keys.map { Color(it) }.maxByOrNull { ratio(it, ground) } ?: continue
            val r = ratio(ink, ground)
            val style = layout(n)?.layoutInput?.style
            val sp = style?.fontSize?.value ?: 14f
            val large = sp >= 24 || (sp >= 18.5f && (style?.fontWeight ?: FontWeight.Normal) >= FontWeight.Bold)
            if (r < if (large) 3.0 else 4.5) out += "contrast ${"%.2f".format(r)}: \"${label(n).take(60)}\""
        }
        screen.recycle()
        return out.distinct()
    }

    private fun ratio(a: Color, b: Color): Double {
        val x = a.luminance() + 0.05
        val y = b.luminance() + 0.05
        return (maxOf(x, y) / minOf(x, y)).toDouble()
    }
}

package dev.starbridge.app.ui

import androidx.compose.ui.unit.sp
import androidx.compose.material3.LocalTextStyle
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.WideNavigationRailDefaults
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.window.core.layout.WindowSizeClass
import dev.starbridge.app.ui.theme.StarbridgeTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Run
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.settings.SettingsViewModel
import dev.starbridge.app.ui.settings.SettingsScreen
import dev.starbridge.app.ui.settings.SettingsActions
import dev.starbridge.app.ui.devices.AddDeviceScreen
import dev.starbridge.app.ui.devices.DevicesViewModel
import dev.starbridge.app.ui.devices.RecoveryKeyScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.FindScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.InboxViewModel
import dev.starbridge.app.ui.inbox.Replies
import dev.starbridge.app.ui.inbox.rememberDrafts
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.ui.inbox.DecisionSheet
import dev.starbridge.app.ui.inbox.PromptSheet
import dev.starbridge.app.ui.inbox.snoozed
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.quotas.QuotasViewModel
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.setup.SetupViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable data object InboxKey : NavKey
@Serializable data class DecisionKey(val id: String) : NavKey
@Serializable data class PromptKey(val id: String) : NavKey
@Serializable data object FindKey : NavKey
@Serializable data object QuotasKey : NavKey
@Serializable data object SettingsKey : NavKey
@Serializable data object DevicesKey : NavKey
@Serializable data object AddDeviceKey : NavKey
/**
 * Add a device with a pairing link, which the camera opened in the app (#611); [at] tells a link
 * scanned again from the one already open, so it is looked up again.
 */
@Serializable data class PairLinkKey(val link: String, val at: Long) : NavKey
@Serializable data object RecoveryKeyKey : NavKey

private val Tab.key: NavKey get() = when (this) {
    Tab.Inbox -> InboxKey
    Tab.Quotas -> QuotasKey
    Tab.Settings -> SettingsKey
}

/** The tab a page belongs to. */
private fun tabOf(key: NavKey?) = when (key) {
    QuotasKey -> Tab.Quotas
    SettingsKey, DevicesKey, AddDeviceKey, is PairLinkKey, RecoveryKeyKey -> Tab.Settings
    else -> Tab.Inbox
}

/** The clock relative times read; it ticks each minute. */
@Composable
private fun now(): Instant = produceState(Instant.now()) {
    while (true) {
        delay(60_000)
        value = Instant.now()
    }
}.value

private val LIVE_RUNS = setOf(Run.State.Running, Run.State.Lost)

/** A clock that ticks each second while [live], for a run's time elapsed; else [slow]. */
@Composable
private fun seconds(live: Boolean, slow: Instant): Instant {
    val fast = produceState(Instant.now(), live) {
        while (live) {
            value = Instant.now()
            delay(1_000)
        }
    }.value
    return if (live) fast else slow
}

/** Shows the store's notices as snackbars. */
@Composable
private fun Notices(notice: StateFlow<String?>, dismiss: () -> Unit): SnackbarHostState {
    val host = remember { SnackbarHostState() }
    val text by notice.collectAsStateWithLifecycle()
    LaunchedEffect(text) {
        text?.let {
            host.showSnackbar(it, withDismissAction = true)
            dismiss()
        }
    }
    return host
}

@Composable
fun Setup(phase: Phase, notice: StateFlow<String?>, dismiss: () -> Unit, openUrl: (String) -> Unit) {
    val vm: SetupViewModel = hiltViewModel()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val server by vm.server.collectAsStateWithLifecycle()
    val keepsKeys by vm.keepsKeys.collectAsStateWithLifecycle()
    val host = Notices(notice, dismiss)
    Scaffold(snackbarHost = { SnackbarHost(host) }) { padding ->
        SetupScreen(phase, server, busy, vm.actions, openUrl, Modifier.padding(padding), keepsKeys)
    }
}

/**
 * A tab's label in the rail, on one line: in the narrow rail a large font shrinks it rather than
 * break it. The floor scales with the font too, so at 2x 8 sp still reads larger than the default.
 */
@Composable
internal fun TabLabel(tab: Tab) = Text(tab.label, maxLines = 1, autoSize = TextAutoSize.StepBased(minFontSize = 8.sp, maxFontSize = LocalTextStyle.current.fontSize))

/**
 * The navigation suite for the window: none on phones, which get [BottomBar]; the wide rail beside
 * wider content, collapsed on a phone in landscape, where its labels would crowd the badge.
 */
@Composable
internal fun suiteType(): NavigationSuiteType {
    val size = currentWindowAdaptiveInfo().windowSizeClass
    return when {
        size.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND) && size.isHeightAtLeastBreakpoint(WindowSizeClass.HEIGHT_DP_MEDIUM_LOWER_BOUND) -> NavigationSuiteType.WideNavigationRailExpanded
        size.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND) -> NavigationSuiteType.WideNavigationRailCollapsed
        else -> NavigationSuiteType.None
    }
}

/**
 * Three tabs in the navigation bar, or a rail on wide screens. The inbox is a list and detail:
 * side by side when the window is wide enough, else the detail stacks on the list and back
 * (predictive back included) returns to it. Back from another tab returns to the inbox.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun Main(decisions: List<Decision>, notice: StateFlow<String?>, dismiss: () -> Unit, opening: Flow<NavKey>) {
    val backStack = rememberNavBackStack(InboxKey)
    val now = now()
    // A snoozed question counts again once it is back (#691).
    val openDecisions = decisions.count { it.isOpen && !it.snoozed(now) }
    // Shared by a decision's card and its detail, which are separate entries.
    val drafts = rememberDrafts()
    val host = Notices(notice, dismiss)
    val sheets = remember { BottomSheetSceneStrategy<NavKey>() }
    val notificationsOff = !rememberNotificationsOn()
    val colors = StarbridgeTheme.colors
    // A notification's tap: its question's or prompt's sheet, over the inbox. A pairing link:
    // Add a device, over Devices.
    LaunchedEffect(opening) {
        opening.collect { key ->
            backStack.clear()
            backStack.add(InboxKey)
            if (key is PairLinkKey) backStack.addAll(listOf(SettingsKey, DevicesKey))
            backStack.add(key)
        }
    }
    val current = backStack.lastOrNull()
    val suite = suiteType()
    // A sheet replaces the sheet on top, so back always returns to the page under it.
    val open = { key: NavKey ->
        if (backStack.lastOrNull() is DecisionKey || backStack.lastOrNull() is PromptKey) backStack.removeAt(backStack.lastIndex)
        backStack.add(key)
    }
    val go = { tab: Tab ->
        backStack.clear()
        backStack.add(InboxKey)
        if (tab != Tab.Inbox) backStack.add(tab.key)
    }
    NavigationSuiteScaffold(
        navigationSuiteType = suite,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            shortNavigationBarContainerColor = MaterialTheme.colorScheme.surfaceContainer,
            wideNavigationRailColors = WideNavigationRailDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        ),
        containerColor = MaterialTheme.colorScheme.surface,
        navigationItems = {
            for (tab in Tab.entries) {
                val selected = tabOf(current) == tab
                NavigationSuiteItem(
                    navigationSuiteType = suite,
                    selected = selected,
                    onClick = { go(tab) },
                    icon = {
                        BadgedBox(badge = { if (tab == Tab.Inbox && openDecisions > 0) Badge(containerColor = colors.accent, contentColor = colors.onAccent) { Text("$openDecisions") } }) {
                            Symbol(tab.sym, filled = selected)
                        }
                    },
                    label = { TabLabel(tab) },
                    modifier = Modifier.semantics { if (tab == Tab.Inbox && openDecisions > 0) stateDescription = "$openDecisions need you" },
                )
            }
        },
    ) {
        val motion = fadeThrough()
        Scaffold(
            snackbarHost = { SnackbarHost(host) },
            // Find covers the screen, as Material's search view does on phones.
            bottomBar = { if (suite == NavigationSuiteType.None && FindKey !in backStack) BottomBar(tabOf(current), openDecisions, go) },
            containerColor = MaterialTheme.colorScheme.surface,
        ) { padding ->
            NavDisplay(
                backStack = backStack,
                modifier = Modifier.fillMaxSize().padding(padding),
                sceneStrategies = listOf(sheets),
                entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator(), rememberViewModelStoreNavEntryDecorator()),
                transitionSpec = { motion },
                popTransitionSpec = { motion },
                predictivePopTransitionSpec = { motion },
                entryProvider = entryProvider {
                    entry<InboxKey> {
                        val vm: InboxViewModel = hiltViewModel()
                        val decisions by vm.decisions.collectAsStateWithLifecycle()
                        val sending by vm.sending.collectAsStateWithLifecycle()
                        val prompts by vm.prompts.collectAsStateWithLifecycle()
                        val runs by vm.runs.collectAsStateWithLifecycle()
                        val view by vm.view.collectAsStateWithLifecycle()
                        val recovery by vm.recovery.collectAsStateWithLifecycle()
                        val members by vm.members.collectAsStateWithLifecycle()
                        InboxScreen(
                            decisions,
                            // A running run's timer, a lost run's "no news for" and the clock of
                            // an item an agent waits on tick each second.
                            seconds(
                                Run.shown(runs, Instant.now()).any { it.state(Instant.now()) in LIVE_RUNS } ||
                                    decisions.any { it.waiting && it.isOpen } || prompts.any { it.waiting(Instant.now()) },
                                now,
                            ),
                            DecisionActions(answer = vm::answer, open = { open(DecisionKey(it)) }, snooze = vm::snooze),
                            refresh = refresh(vm::refresh),
                            replies = Replies(drafts, sending),
                            prompts = prompts,
                            promptActions = PromptActions(answer = vm::answerPrompt, open = { open(PromptKey(it)) }),
                            pollPrompts = vm::refreshPrompts,
                            runs = runs,
                            dismissRun = vm::dismissRun,
                            view = view,
                            onView = vm::setView,
                            onFind = { backStack.add(FindKey) },
                            recovery = recovery,
                            dismissRecovery = vm::dismissRecovery,
                            notificationsOff = notificationsOff,
                            // Members load with the directory, which always holds this phone.
                            noMachine = members.isNotEmpty() && members.none { it.kind == Kind.Machine },
                            snackbar = host,
                        )
                    }
                    entry<FindKey> {
                        val vm: InboxViewModel = hiltViewModel()
                        val decisions by vm.decisions.collectAsStateWithLifecycle()
                        val prompts by vm.prompts.collectAsStateWithLifecycle()
                        FindScreen(
                            decisions,
                            prompts,
                            // As in the inbox: an item an agent waits on ticks each second.
                            seconds(decisions.any { it.waiting && it.isOpen } || prompts.any { it.waiting(Instant.now()) }, now),
                            openDecision = { open(DecisionKey(it)) },
                            openPrompt = { open(PromptKey(it)) },
                            onBack = { backStack.removeAt(backStack.lastIndex) },
                        )
                    }
                    entry<DecisionKey>(metadata = BottomSheetSceneStrategy.sheet) { key ->
                        val vm: InboxViewModel = hiltViewModel()
                        val decisions by vm.decisions.collectAsStateWithLifecycle()
                        val sending by vm.sending.collectAsStateWithLifecycle()
                        val d = decisions.find { it.id == key.id } ?: return@entry
                        DecisionSheet(d, seconds(d.waiting, now), vm::answer, Replies(drafts, sending), onSnooze = { until ->
                            vm.snooze(d.id, until)
                            // Put off, it leaves as an answered question would; brought back, it stays open.
                            if (until.isAfter(Instant.now()) && backStack.lastOrNull() == key) backStack.removeAt(backStack.lastIndex)
                        })
                    }
                    entry<PromptKey>(metadata = BottomSheetSceneStrategy.sheet) { key ->
                        val vm: InboxViewModel = hiltViewModel()
                        val prompts by vm.prompts.collectAsStateWithLifecycle()
                        val p = prompts.find { it.id == key.id } ?: return@entry
                        val at = seconds(p.waiting(Instant.now()), now)
                        PromptSheet(p, at, PromptActions(answer = vm::answerPrompt))
                    }
                    entry<QuotasKey> {
                        val vm: QuotasViewModel = hiltViewModel()
                        val windows by vm.windows.collectAsStateWithLifecycle()
                        val failures by vm.failures.collectAsStateWithLifecycle()
                        val settings by vm.settings.collectAsStateWithLifecycle()
                        val members by vm.members.collectAsStateWithLifecycle()
                        QuotasScreen(
                            windows,
                            now,
                            settings = settings,
                            refresh = refresh(vm::refresh),
                            failures = failures,
                            // Members load with the directory, which always holds this phone.
                            machines = members.takeIf { it.isNotEmpty() }?.filter { it.kind == Kind.Machine }?.map { it.name },
                        )
                    }
                    entry<SettingsKey> {
                        val vm: SettingsViewModel = hiltViewModel()
                        val windows by vm.windows.collectAsStateWithLifecycle()
                        val quota by vm.quota.collectAsStateWithLifecycle()
                        val members by vm.members.collectAsStateWithLifecycle()
                        val colours by vm.colours.collectAsStateWithLifecycle()
                        val push by vm.push.collectAsStateWithLifecycle()
                        val server by vm.server.collectAsStateWithLifecycle()
                        val inbox by vm.inbox.collectAsStateWithLifecycle()
                        val clock by vm.clock.collectAsStateWithLifecycle()
                        val allowUnseen by vm.allowUnseen.collectAsStateWithLifecycle()
                        SettingsScreen(
                            windows, quota, members.size, colours, push, server,
                            SettingsActions(vm::setQuota, vm::setColours, vm::setPush, vm::signOut, devices = { backStack.add(DevicesKey) }, addDevice = { backStack.add(AddDeviceKey) }, inbox = vm::setInbox, clock = vm::setClock, allowUnseen = vm::setAllowUnseen),
                            inbox = inbox,
                            clock = clock,
                            allowUnseen = allowUnseen,
                            notificationsOff = notificationsOff,
                        )
                    }
                    entry<DevicesKey> {
                        val vm: DevicesViewModel = hiltViewModel()
                        val members by vm.members.collectAsStateWithLifecycle()
                        val recovery by vm.recovery.collectAsStateWithLifecycle()
                        DevicesScreen(
                            members, now, vm.actions,
                            onBack = { backStack.removeAt(backStack.lastIndex) },
                            onAdd = { backStack.add(AddDeviceKey) },
                            onScan = { vm.actions.lookUp(it); backStack.add(AddDeviceKey) },
                            pollDirectory = vm::refreshDirectory,
                            recovery = recovery,
                            onReplaceRecovery = { backStack.add(RecoveryKeyKey) },
                        )
                    }
                    entry<RecoveryKeyKey> {
                        val vm: DevicesViewModel = hiltViewModel()
                        val replacing by vm.replacing.collectAsStateWithLifecycle()
                        val busy by vm.busy.collectAsStateWithLifecycle()
                        RecoveryKeyScreen(
                            replacing,
                            busy = busy,
                            actions = vm.recoveryActions,
                            onBack = { backStack.removeAt(backStack.lastIndex) },
                        )
                    }
                    entry<AddDeviceKey> {
                        val vm: DevicesViewModel = hiltViewModel()
                        val approval by vm.approval.collectAsStateWithLifecycle()
                        AddDeviceScreen(approval, vm.actions, onBack = { backStack.removeAt(backStack.lastIndex) })
                    }
                    entry<PairLinkKey> { key ->
                        val vm: DevicesViewModel = hiltViewModel()
                        val approval by vm.approval.collectAsStateWithLifecycle()
                        var looked by rememberSaveable { mutableStateOf(false) }
                        LaunchedEffect(Unit) { if (!looked) { looked = true; vm.actions.lookUp(key.link) } }
                        AddDeviceScreen(approval, vm.actions, onBack = { backStack.removeAt(backStack.lastIndex) })
                    }
                },
            )
        }
    }
}

/**
 * Navigation on the expressive motion scheme, which Navigation 3 does not read on its own: pages
 * fade through, scaling up a little. Questions and prompts open in sheets, which bring their own.
 */
@Composable
private fun fadeThrough(): ContentTransform {
    val scheme = MaterialTheme.motionScheme
    val scale = scheme.defaultSpatialSpec<Float>()
    val effects = scheme.defaultEffectsSpec<Float>()
    val fast = scheme.fastEffectsSpec<Float>()
    return remember(scheme) { (fadeIn(effects) + scaleIn(scale, initialScale = 0.92f)) togetherWith fadeOut(fast) }
}

/** Pull to refresh; the store syncs the directory, decisions and quotas. */
@Composable
private fun refresh(run: () -> Unit): Refresh {
    val vm: RefreshViewModel = hiltViewModel()
    val busy by vm.busy.collectAsStateWithLifecycle()
    return pulled(busy, run)
}

@dagger.hilt.android.lifecycle.HiltViewModel
class RefreshViewModel @javax.inject.Inject constructor(store: dev.starbridge.app.data.Store) : androidx.lifecycle.ViewModel() {
    val busy = store.busy
}

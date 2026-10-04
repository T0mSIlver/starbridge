package dev.starbridge.app.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.navigation3.ListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberListDetailSceneStrategy
import androidx.compose.material3.WideNavigationRailDefaults
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.starbridge.app.data.Phase
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.devices.DevicesViewModel
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.DecisionScreen
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.InboxViewModel
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
@Serializable data object QuotasKey : NavKey
@Serializable data object DevicesKey : NavKey

/** A tab: outlined icon at rest, filled when selected, as Material's navigation bar does. */
private class Tab(val key: NavKey, val label: String, val icon: ImageVector, val selected: ImageVector)

private val tabs = listOf(
    Tab(InboxKey, "Inbox", Icons.Outlined.Inbox, Icons.Rounded.Inbox),
    Tab(QuotasKey, "Quotas", Icons.Outlined.Speed, Icons.Rounded.Speed),
    Tab(DevicesKey, "Devices", Icons.Outlined.Devices, Icons.Rounded.Devices),
)

/** The clock relative times read; it ticks each minute. */
@Composable
private fun now(): Instant = produceState(Instant.now()) {
    while (true) {
        delay(60_000)
        value = Instant.now()
    }
}.value

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
    val host = Notices(notice, dismiss)
    Scaffold(snackbarHost = { SnackbarHost(host) }) { padding ->
        SetupScreen(phase, server, busy, vm.actions, openUrl, Modifier.padding(padding))
    }
}

/** The navigation suite for the window: the short bar on phones, the wide rail beside wider content. */
@Composable
private fun suiteType(): NavigationSuiteType {
    val width = currentWindowAdaptiveInfo().windowSizeClass
    return when {
        width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND) -> NavigationSuiteType.WideNavigationRailExpanded
        width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND) -> NavigationSuiteType.WideNavigationRailCollapsed
        else -> NavigationSuiteType.ShortNavigationBarCompact
    }
}

/**
 * Three tabs in the navigation bar, or a rail on wide screens. The inbox is a list and detail:
 * side by side when the window is wide enough, else the detail stacks on the list and back
 * (predictive back included) returns to it. Back from another tab returns to the inbox.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun Main(openDecisions: Int, notice: StateFlow<String?>, dismiss: () -> Unit, openDecision: Flow<String>) {
    val backStack = rememberNavBackStack(InboxKey)
    val now = now()
    val host = Notices(notice, dismiss)
    val listDetail = rememberListDetailSceneStrategy<NavKey>()
    val twoPane = calculatePaneScaffoldDirective(currentWindowAdaptiveInfo()).maxHorizontalPartitions > 1
    val colors = StarbridgeTheme.colors
    LaunchedEffect(openDecision) {
        openDecision.collect { id ->
            backStack.clear()
            backStack.add(InboxKey)
            backStack.add(DecisionKey(id))
        }
    }
    val current = backStack.lastOrNull()
    NavigationSuiteScaffold(
        navigationSuiteType = suiteType(),
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            shortNavigationBarContainerColor = colors.surface,
            wideNavigationRailColors = WideNavigationRailDefaults.colors(containerColor = colors.bg),
        ),
        containerColor = colors.bg,
        navigationItems = {
            for (tab in tabs) {
                val selected = current == tab.key || (tab.key == InboxKey && current is DecisionKey)
                NavigationSuiteItem(
                    selected = selected,
                    onClick = {
                        backStack.clear()
                        backStack.add(InboxKey)
                        if (tab.key != InboxKey) backStack.add(tab.key)
                    },
                    icon = {
                        // Open decisions need the owner: the beacon, a dot, not a count in error red.
                        val beacon = tab.key == InboxKey && openDecisions > 0
                        BadgedBox(badge = { if (beacon) Badge(containerColor = colors.accent) }) {
                            Icon(if (selected) tab.selected else tab.icon, contentDescription = null)
                        }
                    },
                    label = { Text(tab.label) },
                    modifier = Modifier.semantics { if (tab.key == InboxKey && openDecisions > 0) stateDescription = "$openDecisions need you" },
                )
            }
        },
    ) {
        Scaffold(snackbarHost = { SnackbarHost(host) }, containerColor = colors.bg) { padding ->
            NavDisplay(
                backStack = backStack,
                modifier = Modifier.fillMaxSize().padding(padding),
                sceneStrategies = listOf(listDetail),
                entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator(), rememberViewModelStoreNavEntryDecorator()),
                entryProvider = entryProvider {
                    entry<InboxKey>(
                        metadata = ListDetailSceneStrategy.listPane(detailPlaceholder = { DecisionScreen(null, now, onAnswer = { _, _, _ -> }) }),
                    ) {
                        val vm: InboxViewModel = hiltViewModel()
                        val decisions by vm.decisions.collectAsStateWithLifecycle()
                        val selected = (backStack.lastOrNull() as? DecisionKey)?.id
                        InboxScreen(
                            decisions,
                            now,
                            DecisionActions(answer = vm::answer, open = { id ->
                                if (backStack.lastOrNull() is DecisionKey) backStack.removeAt(backStack.lastIndex)
                                backStack.add(DecisionKey(id))
                            }),
                            selected = selected,
                            refresh = refresh(vm::refresh),
                        )
                    }
                    entry<DecisionKey>(metadata = ListDetailSceneStrategy.detailPane()) { key ->
                        val vm: InboxViewModel = hiltViewModel()
                        val decisions by vm.decisions.collectAsStateWithLifecycle()
                        DecisionScreen(
                            decisions.find { it.id == key.id },
                            now,
                            onAnswer = vm::answer,
                            onBack = if (twoPane) null else ({ backStack.removeAt(backStack.lastIndex) }),
                        )
                    }
                    entry<QuotasKey> {
                        val vm: QuotasViewModel = hiltViewModel()
                        val windows by vm.windows.collectAsStateWithLifecycle()
                        QuotasScreen(windows, now, refresh = refresh(vm::refresh))
                    }
                    entry<DevicesKey> {
                        val vm: DevicesViewModel = hiltViewModel()
                        val members by vm.members.collectAsStateWithLifecycle()
                        val approval by vm.approval.collectAsStateWithLifecycle()
                        val push by vm.push.collectAsStateWithLifecycle()
                        val server by vm.server.collectAsStateWithLifecycle()
                        val colours by vm.colours.collectAsStateWithLifecycle()
                        DevicesScreen(members, approval, push, server, now, vm.actions, colours = colours)
                    }
                },
            )
        }
    }
}

/** Pull to refresh; the store syncs the directory, decisions and quotas. */
@Composable
private fun refresh(run: () -> Unit): Refresh {
    val vm: RefreshViewModel = hiltViewModel()
    val busy by vm.busy.collectAsStateWithLifecycle()
    return Refresh(busy, run)
}

@dagger.hilt.android.lifecycle.HiltViewModel
class RefreshViewModel @javax.inject.Inject constructor(store: dev.starbridge.app.data.Store) : androidx.lifecycle.ViewModel() {
    val busy = store.busy
}

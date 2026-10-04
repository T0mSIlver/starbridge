package dev.starbridge.app.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.devices.DevicesViewModel
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.inbox.InboxViewModel
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.quotas.QuotasViewModel
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.setup.SetupStep
import dev.starbridge.app.ui.setup.SetupViewModel
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable data object InboxKey : NavKey
@Serializable data object QuotasKey : NavKey
@Serializable data object DevicesKey : NavKey

private class Tab(val key: NavKey, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab(InboxKey, "Inbox", Icons.Rounded.Inbox),
    Tab(QuotasKey, "Quotas", Icons.Rounded.Speed),
    Tab(DevicesKey, "Devices", Icons.Rounded.Devices),
)

/** The clock relative times read; it ticks each minute. */
@Composable
private fun now(): Instant = produceState(Instant.now()) {
    while (true) {
        delay(60_000)
        value = Instant.now()
    }
}.value

@Composable
fun Setup() {
    val vm: SetupViewModel = hiltViewModel()
    var step by rememberSaveable { mutableStateOf(SetupStep.SignIn) }
    Scaffold { padding ->
        SetupScreen(
            step = step,
            words = vm.words,
            onSignIn = { step = SetupStep.RecoveryKey },
            onDone = vm::finish,
            modifier = Modifier.padding(padding),
        )
    }
}

/** Three tabs; each is the only entry on the back stack, so back leaves the app. */
@Composable
fun Main(openDecisions: Int, pairings: Int) {
    val backStack = rememberNavBackStack(InboxKey)
    val now = now()
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (tab in tabs) {
                    val count = when (tab.key) {
                        InboxKey -> openDecisions
                        DevicesKey -> pairings
                        else -> 0
                    }
                    NavigationBarItem(
                        selected = backStack.lastOrNull() == tab.key,
                        onClick = { backStack.clear(); backStack.add(tab.key) },
                        icon = {
                            BadgedBox(badge = { if (count > 0) Badge { Text("$count") } }) { Icon(tab.icon, contentDescription = null) }
                        },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavDisplay(
            backStack = backStack,
            modifier = Modifier.fillMaxSize().padding(padding),
            entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator(), rememberViewModelStoreNavEntryDecorator()),
            entryProvider = entryProvider {
                entry<InboxKey> {
                    val vm: InboxViewModel = hiltViewModel()
                    val decisions by vm.decisions.collectAsStateWithLifecycle()
                    InboxScreen(decisions, now, onAnswer = vm::answer)
                }
                entry<QuotasKey> {
                    val vm: QuotasViewModel = hiltViewModel()
                    val windows by vm.windows.collectAsStateWithLifecycle()
                    QuotasScreen(windows, now)
                }
                entry<DevicesKey> {
                    val vm: DevicesViewModel = hiltViewModel()
                    val members by vm.members.collectAsStateWithLifecycle()
                    val pending by vm.pairings.collectAsStateWithLifecycle()
                    DevicesScreen(members, pending, now, DeviceActions(vm::approve, vm::deny, vm::revoke))
                }
            },
        )
    }
}

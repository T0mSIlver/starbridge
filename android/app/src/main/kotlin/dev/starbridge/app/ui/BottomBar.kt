package dev.starbridge.app.ui

import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ShortNavigationBar
import androidx.compose.material3.ShortNavigationBarItem
import androidx.compose.material3.ShortNavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.add
import androidx.compose.material3.ShortNavigationBarDefaults
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.theme.StarbridgeTheme

/** The three tabs; Devices lives inside Settings. */
enum class Tab(val label: String, val sym: Sym) {
    Inbox("Inbox", Sym.Inbox),
    Quotas("Quotas", Sym.Speed),
    Settings("Settings", Sym.Settings),
}

/**
 * Material 3 Expressive's short navigation bar: the selected tab's symbol filled on its pill. The
 * inbox carries how many items need the owner, in amber.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BottomBar(selected: Tab, needYou: Int, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier, tabs: List<Tab> = Tab.entries) {
    val scheme = MaterialTheme.colorScheme
    val colors = StarbridgeTheme.colors
    // 80 dp with the items centred, as the mockups: the short bar's 64 dp and 8 dp each side.
    ShortNavigationBar(
        modifier,
        containerColor = scheme.surfaceContainer,
        windowInsets = ShortNavigationBarDefaults.windowInsets.add(WindowInsets(top = 8.dp, bottom = 8.dp)),
    ) {
        tabs.forEach { tab ->
            val on = tab == selected
            ShortNavigationBarItem(
                selected = on,
                onClick = { onSelect(tab) },
                icon = {
                    BadgedBox(badge = {
                        if (tab == Tab.Inbox && needYou > 0) Badge(containerColor = colors.accent, contentColor = colors.onAccent) { Text("$needYou") }
                    }) { Symbol(tab.sym, size = 22.dp, filled = on) }
                },
                label = { Text(tab.label, style = StarbridgeTheme.type.tab, color = if (on) scheme.onSurface else scheme.onSurfaceVariant) },
                colors = ShortNavigationBarItemDefaults.colors().copy(
                    selectedIconColor = scheme.onSurface,
                    selectedIndicatorColor = scheme.surfaceContainerHighest,
                    unselectedIconColor = scheme.onSurfaceVariant,
                ),
                modifier = Modifier.semantics { if (tab == Tab.Inbox && needYou > 0) stateDescription = "$needYou need you" },
            )
        }
    }
}

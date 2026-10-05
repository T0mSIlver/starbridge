package dev.starbridge.app.ui.quotas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaSettings.Ticks
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.ui.Choice
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Screen
import dev.starbridge.app.ui.groupGap
import dev.starbridge.app.ui.groupShape
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

/** CodexBar's quota settings, for this phone only: bars, providers and notifications. */
@Composable
fun QuotaSettingsScreen(windows: List<QuotaWindow>, settings: QuotaSettings, onChange: (QuotaSettings) -> Unit, modifier: Modifier = Modifier) {
    val providers = settings.providers(windows)
    fun toggle(list: List<String>, p: String, on: Boolean) = if (on) (list + p).distinct() else list - p
    fun move(i: Int, by: Int) = onChange(settings.copy(order = providers.toMutableList().apply { add(i + by, removeAt(i)) }))

    Screen("Quota settings", modifier, subtitle = { Text("These stay on this phone") }) { padding ->
        LazyColumn(contentPadding = listPadding(padding), verticalArrangement = Arrangement.spacedBy(groupGap)) {
            item { Section("Bars") }
            val bars = if (settings.workDays == null) 3 else 4
            item {
                Setting(groupShape(0, bars), "Bars show") {
                    Choice(listOf(true to "Used", false to "Remaining"), settings.showUsed, { onChange(settings.copy(showUsed = it)) }, Modifier.fillMaxWidth())
                }
            }
            item {
                Setting(groupShape(1, bars), "Reset times") {
                    Choice(listOf(false to "In 2 h", true to "Clock time"), settings.absoluteResets, { onChange(settings.copy(absoluteResets = it)) }, Modifier.fillMaxWidth())
                }
            }
            item {
                Setting(groupShape(2, bars), "Workdays on weekly bars") {
                    Choice(listOf(null to "Off", 4 to "4", 5 to "5", 7 to "7"), settings.workDays, { onChange(settings.copy(workDays = it)) }, Modifier.fillMaxWidth())
                    Hint("Ticks mark each workday from Monday, and the pace marker counts workdays only.")
                }
            }
            if (settings.workDays != null) item {
                Setting(groupShape(3, bars), "Workday ticks") {
                    Choice(listOf(Ticks.Subtle to "Subtle", Ticks.HighContrast to "Strong", Ticks.Hidden to "Hidden"), settings.ticks, { onChange(settings.copy(ticks = it)) }, Modifier.fillMaxWidth())
                }
            }

            item { Section("Providers") }
            if (providers.isEmpty()) item { Hint("No provider has sent a quota yet.") }
            itemsIndexed(providers, key = { _, p -> p }) { i, p ->
                Surface(Modifier.fillMaxWidth().animateItem(), shape = groupShape(i, providers.size), color = MaterialTheme.colorScheme.surfaceContainer) {
                    Column(Modifier.padding(start = Spacing.s5, end = Spacing.s2, top = Spacing.s3, bottom = Spacing.s3)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p, style = StarbridgeTheme.type.action, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                            IconButton(onClick = { move(i, -1) }, enabled = i > 0) { Icon(Icons.Rounded.KeyboardArrowUp, contentDescription = "Move $p up") }
                            IconButton(onClick = { move(i, 1) }, enabled = i < providers.lastIndex) { Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = "Move $p down") }
                        }
                        Toggle("Show", p !in settings.hidden) { onChange(settings.copy(hidden = toggle(settings.hidden, p, !it))) }
                        Toggle("Notify", p in settings.notify) { onChange(settings.copy(notify = toggle(settings.notify, p, it))) }
                    }
                }
            }

            item { Section("Notify about") }
            item {
                Setting(groupShape(0, 2), null) {
                    Toggle("50% and 20% left", settings.notifyLow) { onChange(settings.copy(notifyLow = it)) }
                }
            }
            item {
                Setting(groupShape(1, 2), null) {
                    Toggle("Will run out, or resets with headroom unused", settings.notifyPace) { onChange(settings.copy(notifyPace = it)) }
                    Hint("Once per window per reset, for the providers set to notify, on the Quotas channel.")
                }
            }
        }
    }
}

@Composable
private fun Section(text: String) {
    Label(text, Modifier.padding(start = Spacing.s1, top = Spacing.s6, bottom = Spacing.s2))
}

/** One row of a grouped list, with its setting's name. */
@Composable
private fun Setting(shape: Shape, title: String?, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = shape, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = Spacing.s5, vertical = Spacing.s4)) {
            if (title != null) {
                Text(title, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.padding(top = Spacing.s3))
            }
            content()
        }
    }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(end = Spacing.s3), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Spacing.s3))
}

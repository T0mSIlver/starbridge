package dev.starbridge.app.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.text.format.DateFormat
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dev.starbridge.app.data.Clock
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.di.app
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Section
import dev.starbridge.app.ui.rowShape
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.launch
import java.time.Instant

/** A plan in the picker: its quotas as the Quotas screen orders them; none once it stopped reporting. */
internal class PickerPlan(val plan: Plan, val rows: List<QuotaRow>)

/**
 * The picker's plans, every one the account reports in the Quotas screen's order, hidden ones
 * too. A [chosen] plan that no longer reports stays at the end, so the picker still shows what the
 * widget shows. [windows] is null while this phone is not in an account.
 */
internal fun pickerPlans(windows: List<QuotaWindow>?, settings: QuotaSettings, now: Instant, h24: Boolean, chosen: Choice?): List<PickerPlan> {
    val rows = QuotaRow.of(windows.orEmpty(), settings.copy(hidden = emptyList()), now, h24)
    val plans = rows.groupBy { Plan.of(it.window) }.map { (plan, rows) -> PickerPlan(plan, rows) }
    val gone = chosen?.plan?.takeIf { c -> plans.none { it.plan == c } }?.let { PickerPlan(it, emptyList()) }
    return plans + listOfNotNull(gone)
}

/**
 * Picks what a Quotas widget shows, in one tap where it can: a 2×2 ([wide] false) takes one quota;
 * a 4×2 takes a plan's two quotas, or, for a plan with more, the two ticked. "Running out first"
 * shows whatever leads the Quotas screen. Back keeps what the widget shows.
 */
@Composable
internal fun QuotaPicker(plans: List<PickerPlan>, wide: Boolean, chosen: Choice?, signedIn: Boolean, onPick: (Choice?) -> Unit) {
    // A 4×2's first tick on a plan with more than two quotas.
    var ticked by remember { mutableStateOf<Choice?>(null) }
    Page("Quotas widget", subtitle = { Text(if (wide) "Two quotas of one plan" else "One quota", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant) }) {
        item { Section("Show") }
        item { PickRow(0, 1, "Running out first", "Whatever leads your Quotas screen", chosen == null, null) { onPick(null) } }
        plans.forEach { group ->
            val plan = group.plan
            val mine = chosen?.takeIf { it.plan == plan }
            if (group.rows.isEmpty()) {
                item { Section(plan.name) }
                item { PickRow(0, 1, "Not in your quotas now", "What this widget shows", mine != null, StarbridgeTheme.provider(plan.provider)) { onPick(mine) } }
                return@forEach
            }
            if (wide && group.rows.size <= 2) {
                val all = Choice(plan, group.rows.map { it.window.window })
                item { Section(plan.name) }
                item(key = plan.name) {
                    val title = group.rows.joinToString(" and ") { it.window.window }
                    PickRow(0, 1, title, group.rows.joinToString(" · ") { "${it.percent}%" }, mine != null, StarbridgeTheme.provider(plan.provider)) { onPick(all) }
                }
                return@forEach
            }
            item { Section(if (wide) "${plan.name}: pick two" else plan.name) }
            group.rows.forEachIndexed { i, row ->
                val quota = row.window.window
                val sub = "${row.percent}% · ${row.word}"
                item(key = "${plan.name}/$quota") {
                    if (!wide) PickRow(i, group.rows.size, quota, sub, mine?.quotas == listOf(quota), StarbridgeTheme.provider(plan.provider)) { onPick(Choice(plan, listOf(quota))) }
                    else {
                        val on = (ticked ?: mine)?.takeIf { it.plan == plan }?.quotas.orEmpty()
                        PickRow(i, group.rows.size, quota, sub, quota in on, StarbridgeTheme.provider(plan.provider), check = true) {
                            val now = ticked?.takeIf { it.plan == plan }?.quotas.orEmpty()
                            when {
                                quota in now -> ticked = Choice(plan, now - quota)
                                now.isEmpty() -> ticked = Choice(plan, listOf(quota))
                                else -> onPick(Choice(plan, now + quota))
                            }
                        }
                    }
                }
            }
        }
        if (!signedIn) item {
            Text(
                "Sign in to Starbridge to pick your quotas.",
                style = StarbridgeTheme.type.small,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Spacing.s2, top = Spacing.s3),
            )
        }
    }
}

/** A row of the picker: a radio, or a check box where a 4×2 ticks two quotas. */
@Composable
private fun PickRow(index: Int, count: Int, title: String, sub: String, selected: Boolean, dot: Color?, check: Boolean = false, onClick: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().selectable(selected, role = if (check) Role.Checkbox else Role.RadioButton, onClick = onClick),
        shape = rowShape(index, count),
        color = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(Spacing.s4),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            dot?.let { Box(Modifier.size(12.dp).background(it, CircleShape)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
                Text(sub, style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (check) Checkbox(checked = selected, onCheckedChange = null) else RadioButton(selected = selected, onClick = null)
        }
    }
}

/**
 * The Quotas widget's configuration (#907): the launcher opens it when the widget is dropped and
 * from Reconfigure on a long press. The widget's width when it opens decides one quota or two.
 * The widget is placed whatever happens: backing out keeps what it shows, "Running out first" for
 * a new one.
 */
class QuotasWidgetSetup : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT), SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        // Portrait draws a widget at its minimum width, as QuotasWidget's 250 dp test reads it.
        val wide = AppWidgetManager.getInstance(this).getAppWidgetOptions(widgetId).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) >= 250
        val app = app()
        val store = app.store()
        val prefs = app.prefs()
        val self = this
        lifecycleScope.launch {
            val glanceId = GlanceAppWidgetManager(self).getGlanceIdBy(widgetId)
            val chosen = Choice.read(getAppWidgetState(self, PreferencesGlanceStateDefinition, glanceId))
            // A new widget draws once now: the system sends no update while its setup is open.
            QuotasWidget().update(self, glanceId)
            setContent {
                val colours by prefs.colours.collectAsStateWithLifecycle()
                val clock by prefs.clock.collectAsStateWithLifecycle()
                val phase by store.phase.collectAsStateWithLifecycle()
                val windows by store.windows.collectAsStateWithLifecycle()
                val settings by prefs.quota.collectAsStateWithLifecycle()
                val signedIn = phase == Phase.Ready
                val h24 = when (clock) {
                    Clock.System -> DateFormat.is24HourFormat(self)
                    Clock.H24 -> true
                    Clock.H12 -> false
                }
                StarbridgeTheme(colours = colours) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).safeDrawingPadding()) {
                        QuotaPicker(pickerPlans(windows.takeIf { signedIn }, settings, Instant.now(), h24, chosen), wide, chosen, signedIn) { choice ->
                            lifecycleScope.launch {
                                updateAppWidgetState(self, glanceId) { Choice.write(it, choice) }
                                QuotasWidget().update(self, glanceId)
                                finish()
                            }
                        }
                    }
                }
            }
        }
    }
}

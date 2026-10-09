package dev.starbridge.app.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
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

/** A picker row: a plan, or null for whichever leads the Quotas screen, with what it shows now. */
internal class PlanChoice(val plan: Plan?, val title: String, val sub: String)

/**
 * The picker's rows: whichever leads, then every plan the account reports in the Quotas screen's
 * order, hidden ones too. A [chosen] plan that no longer reports stays at the end, so the picker
 * still shows what the widget shows. [windows] is null while this phone is not in an account.
 */
internal fun planChoices(windows: List<QuotaWindow>?, settings: QuotaSettings, now: Instant, chosen: Plan?): List<PlanChoice> {
    val lead = PlanChoice(null, "Running out first", "Whichever plan leads your Quotas screen")
    val plans = settings.groups(settings.copy(hidden = emptyList()).arrange(windows.orEmpty(), now)).map { group ->
        PlanChoice(Plan.of(group.first()), Plan.of(group.first()).name, group.joinToString(" · ") { "${it.window} ${settings.bar(it, now).percent}%" })
    }
    val gone = chosen?.takeIf { c -> plans.none { it.plan == c } }?.let { PlanChoice(it, it.name, "Not in your quotas now") }
    return listOf(lead) + plans + listOfNotNull(gone)
}

/** One tap picks a plan; Back keeps the one shown. */
@Composable
internal fun PlanPicker(choices: List<PlanChoice>, chosen: Plan?, signedIn: Boolean, onPick: (Plan?) -> Unit) {
    Page("Quotas widget") {
        item { Section("Show") }
        choices.forEachIndexed { i, c ->
            item(key = c.plan?.name ?: "") {
                Surface(
                    Modifier.fillMaxWidth().selectable(c.plan == chosen, role = Role.RadioButton) { onPick(c.plan) },
                    shape = rowShape(i, choices.size),
                    color = MaterialTheme.colorScheme.surfaceContainer,
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(Spacing.s4),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s4),
                    ) {
                        c.plan?.let { Box(Modifier.size(12.dp).background(StarbridgeTheme.provider(it.provider), CircleShape)) }
                        Column(Modifier.weight(1f)) {
                            Text(c.title, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
                            Text(c.sub, style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        RadioButton(selected = c.plan == chosen, onClick = null)
                    }
                }
            }
        }
        if (!signedIn) item {
            Text(
                "Sign in to Starbridge to pick one of your plans.",
                style = StarbridgeTheme.type.small,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Spacing.s2, top = Spacing.s3),
            )
        }
    }
}

/**
 * The Quotas widget's configuration (#907): the launcher opens it when the widget is dropped and
 * from Reconfigure on a long press. The widget is placed whatever happens: backing out keeps the
 * plan it shows, "Running out first" for a new one.
 */
class QuotasWidgetSetup : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        val done = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        setResult(Activity.RESULT_OK, done)
        val app = app()
        val store = app.store()
        val prefs = app.prefs()
        lifecycleScope.launch {
            val glanceId = GlanceAppWidgetManager(this@QuotasWidgetSetup).getGlanceIdBy(widgetId)
            val chosen = Plan.read(getAppWidgetState(this@QuotasWidgetSetup, PreferencesGlanceStateDefinition, glanceId))
            // A new widget draws once now: the system sends no update while its setup is open.
            QuotasWidget().update(this@QuotasWidgetSetup, glanceId)
            setContent {
                val colours by prefs.colours.collectAsStateWithLifecycle()
                val phase by store.phase.collectAsStateWithLifecycle()
                val windows by store.windows.collectAsStateWithLifecycle()
                val settings by prefs.quota.collectAsStateWithLifecycle()
                val signedIn = phase == Phase.Ready
                StarbridgeTheme(colours = colours) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).safeDrawingPadding()) {
                        PlanPicker(planChoices(windows.takeIf { signedIn }, settings, Instant.now(), chosen), chosen, signedIn) { plan ->
                            lifecycleScope.launch {
                                updateAppWidgetState(this@QuotasWidgetSetup, glanceId) { Plan.write(it, plan) }
                                QuotasWidget().update(this@QuotasWidgetSetup, glanceId)
                                finish()
                            }
                        }
                    }
                }
            }
        }
    }
}

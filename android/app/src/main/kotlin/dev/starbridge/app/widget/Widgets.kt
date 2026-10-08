package dev.starbridge.app.widget

import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.color.DynamicThemeColorProviders
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.starbridge.app.MainActivity
import dev.starbridge.app.data.Clock
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.di.app
import dev.starbridge.app.ui.inbox.snoozed
import dev.starbridge.app.ui.quotas.Course
import dev.starbridge.app.ui.quotas.Mood
import dev.starbridge.app.ui.quotas.course
import dev.starbridge.app.ui.quotas.state
import dev.starbridge.app.ui.theme.DarkColors
import dev.starbridge.app.ui.theme.DarkProviders
import dev.starbridge.app.ui.theme.LightColors
import dev.starbridge.app.ui.theme.LightProviders
import dev.starbridge.app.ui.theme.StarbridgeColors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import java.time.Instant

// The home-screen widgets (#894): "Needs you", the count of questions, and Quotas. Glance draws
// them as RemoteViews, so they follow the app's look with Glance's means: the tokens as day and
// night colours, the system's widget radius, the default sans (RemoteViews cannot load the app's
// fonts).

/** The colours a widget draws with, under the Colours setting; amber, the quota states and lab colours stay fixed. */
class Palette(
    val card: ColorProvider,
    val tonal: ColorProvider,
    val fg: ColorProvider,
    val fg2: ColorProvider,
    val accent: ColorProvider,
    /** `accent-soft`, drawn over [card]: a whole widget whose count blocks an agent. */
    val amber: ColorProvider,
    val ok: ColorProvider,
    val warn: ColorProvider,
    val bad: ColorProvider,
) {
    fun provider(name: String): ColorProvider {
        val id = name.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
        return ColorProvider(day = LightProviders[id] ?: LightColors.fg3, night = DarkProviders[id] ?: DarkColors.fg3)
    }

    companion object {
        private fun pair(f: (StarbridgeColors) -> Color) = ColorProvider(day = f(LightColors), night = f(DarkColors))

        fun of(colours: Colours): Palette {
            // "Material You" maps the neutrals as the app's theme does (Theme.kt, wallpaper()).
            val m = DynamicThemeColorProviders
            val wallpaper = colours == Colours.Wallpaper
            return Palette(
                card = if (wallpaper) m.surface else pair { it.surface },
                tonal = if (wallpaper) m.surfaceVariant else pair { it.surface2 },
                fg = if (wallpaper) m.onSurface else pair { it.fg },
                fg2 = if (wallpaper) m.onSurfaceVariant else pair { it.fg2 },
                accent = pair { it.accent },
                amber = pair { it.accentSoft },
                ok = pair { it.ok },
                warn = pair { it.warn },
                bad = pair { it.bad },
            )
        }
    }
}

private fun style(size: TextUnit, color: ColorProvider, medium: Boolean = false, align: TextAlign? = null) =
    TextStyle(color = color, fontSize = size, fontWeight = if (medium) FontWeight.Medium else FontWeight.Normal, textAlign = align)

/** A filled card with the launcher's widget radius, opening [intent]; [amber] tints it whole. */
@Composable
private fun Card(p: Palette, intent: Intent, amber: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().cornerRadius(android.R.dimen.system_app_widget_background_radius)
            .background(p.card).clickable(actionStartActivity(intent)),
    ) {
        val tint = if (amber) GlanceModifier.background(p.amber) else GlanceModifier
        Column(GlanceModifier.fillMaxSize().then(tint).padding(18.dp), content = content)
    }
}

private fun open(context: Context, tab: String? = null) = Intent(context, MainActivity::class.java)
    .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    .apply { tab?.let { putExtra(MainActivity.EXTRA_TAB, it) } }

// ---- Needs you ----

/** The questions the Inbox's badge counts (open, not snoozed), and how many of them an agent waits on. */
data class NeedsYou(val open: Int, val waiting: Int) {
    companion object {
        fun of(decisions: List<Decision>, now: Instant): NeedsYou {
            val open = decisions.filter { it.isOpen && !it.snoozed(now) }
            return NeedsYou(open.size, open.count { it.waiting })
        }
    }
}

/**
 * 2×2: how many questions wait on the owner, amber only when an agent is blocked on one; else how
 * many are open. [needs] is null while this phone is not in an account.
 */
@Composable
fun NeedsYouWidget(needs: NeedsYou?, p: Palette) {
    val waiting = needs?.waiting ?: 0
    Card(p, open(LocalContext.current), amber = waiting > 0) {
        Text("Needs you", style = style(14.sp, p.fg2, medium = true), maxLines = 1)
        Spacer(GlanceModifier.defaultWeight())
        if (needs == null) {
            Text("Not signed in", style = style(16.sp, p.fg))
            return@Card
        }
        Text(
            "${if (waiting > 0) waiting else needs.open}",
            style = style(57.sp, if (waiting > 0) p.accent else p.fg, medium = true),
            maxLines = 1,
        )
        Text(
            when {
                waiting > 0 -> "waiting on you"
                needs.open > 0 -> "when you can"
                else -> "nothing open"
            },
            style = style(16.sp, p.fg),
            maxLines = 1,
        )
        val rest = needs.open - waiting
        Text(if (waiting > 0 && rest > 0) "$rest more when you can" else "", style = style(13.sp, p.fg2), maxLines = 1)
    }
}

class QuestionsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Single

    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { Live { store, prefs -> Questions(store, prefs) } }

    override suspend fun providePreview(context: Context, widgetCategory: Int) = provideContent { Live { store, prefs -> Questions(store, prefs) } }

    @Composable
    private fun Questions(store: Store, prefs: Prefs) {
        val phase by store.phase.collectAsState()
        val decisions by store.decisions.collectAsState()
        val colours by prefs.colours.collectAsState()
        NeedsYouWidget(if (phase == Phase.Ready) NeedsYou.of(decisions, Instant.now()) else null, Palette.of(colours))
    }
}

class QuestionsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = QuestionsWidget()
}

// ---- Quotas ----

/** A window as a widget row: its bar on the owner's scale, where it is headed, and its state in words. */
internal class QuotaRow(val window: QuotaWindow, val bar: QuotaSettings.Bar, val course: Course, val mood: Mood, val word: String) {
    /** The figure and the fill: a window that ran out reads 100% used, as on the Quotas screen. */
    val percent: Int get() = if (course == Course.RanOut && bar.word == "used") 100 else bar.percent.coerceIn(0, 100)

    companion object {
        /** The windows as the Quotas screen orders them, under the owner's quota settings. */
        fun of(windows: List<QuotaWindow>, settings: QuotaSettings, now: Instant, h24: Boolean): List<QuotaRow> =
            settings.arrange(windows, now).map { w ->
                val (mood, word) = w.state(now, settings.absoluteResets, h24)
                QuotaRow(w, settings.bar(w, now), w.course(now), mood, word)
            }
    }
}

/**
 * The app's meter (ui/quotas/Meter.kt) in Glance's boxes: the fill in the lab colour, a gap, the
 * track; the pace tick in `fg`; a red cap at the limit when the window will run out or ran out.
 * Glance draws no paths, so the overrun is not hatched.
 */
@Composable
private fun Meter(row: QuotaRow, width: Dp, p: Palette) {
    val h = 8.dp
    val reach = 16.dp
    val ranOut = row.course == Course.RanOut
    val fraction = row.percent / 100f
    val fill = width * fraction
    val gap = 4.dp
    Box(GlanceModifier.width(width).height(reach), contentAlignment = Alignment.CenterStart) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (fill > gap) Box(GlanceModifier.width(fill - gap / 2).height(h).cornerRadius(h / 2).background(p.provider(row.window.provider))) {}
            if (width - fill > gap) {
                if (fill > gap) Spacer(GlanceModifier.width(gap))
                Box(GlanceModifier.width(width - fill - if (fill > gap) gap / 2 else 0.dp).height(h).cornerRadius(h / 2).background(p.tonal)) {}
            }
        }
        // At the limit: the full end when the bar shows use, its start when it shows what's left.
        if (row.course != Course.Steady) Row {
            if (row.bar.word == "used") Spacer(GlanceModifier.width(width - 3.dp))
            Box(GlanceModifier.width(3.dp).height(reach).cornerRadius(2.dp).background(p.bad)) {}
        }
        if (!ranOut) row.bar.steady?.let {
            Row {
                Spacer(GlanceModifier.width((width * (it.coerceIn(0, 100) / 100f) - 1.5.dp).coerceAtLeast(0.dp)))
                Box(GlanceModifier.width(3.dp).height(reach).cornerRadius(2.dp).background(p.fg)) {}
            }
        }
    }
}

private fun Mood.color(p: Palette) = when (this) {
    Mood.Ok -> p.ok
    Mood.Bad -> p.bad
    Mood.Warn -> p.warn
    Mood.Neutral -> p.fg2
}

/**
 * 2×2: the first window ("Running out first" puts one that runs out there) as a figure, its meter
 * and its state. 4×2: every window that fits, under its provider, each a meter and a figure. [rows]
 * is null while this phone is not in an account.
 */
@Composable
internal fun QuotasWidget(rows: List<QuotaRow>?, p: Palette) {
    val size = LocalSize.current
    Card(p, open(LocalContext.current, MainActivity.TAB_QUOTAS)) {
        val first = rows?.firstOrNull()
        if (first == null) {
            Text("Quotas", style = style(14.sp, p.fg2, medium = true), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            Text(if (rows == null) "Not signed in" else "No quotas yet", style = style(16.sp, p.fg))
            return@Card
        }
        val inner = size.width - 36.dp
        if (size.width < 250.dp) {
            Text("${first.window.provider} · ${first.window.window}", style = style(14.sp, p.fg2, medium = true), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            Text("${first.percent}%", style = style(45.sp, p.fg, medium = true), maxLines = 1)
            Spacer(GlanceModifier.height(4.dp))
            Meter(first, inner, p)
            Spacer(GlanceModifier.height(4.dp))
            Text(first.word, style = style(13.sp, first.mood.color(p), medium = first.mood == Mood.Bad), maxLines = 1)
            return@Card
        }
        val name = 64.dp
        val figure = 44.dp
        val meter = inner - name - figure - 12.dp
        // Whole providers and rows while they fit: a heading 20 dp, a row 22 dp, 6 dp between providers.
        var room = size.height - 36.dp
        val groups = rows.groupBy { it.window.provider to it.window.machine }.values.mapNotNull { group ->
            val head = if (room == size.height - 36.dp) 20.dp else 26.dp
            val fits = ((room - head) / 22.dp).toInt().coerceAtMost(group.size)
            if (fits < 1) return@mapNotNull null
            room -= head + 22.dp * fits
            group.take(fits)
        }
        // Glance caps a container at 10 children: each provider is its own column.
        groups.take(5).forEachIndexed { i, group ->
            if (i > 0) Spacer(GlanceModifier.height(6.dp))
            Column(GlanceModifier.fillMaxWidth()) {
                val w = group.first().window
                Text(w.machine?.let { "${w.provider} · $it" } ?: w.provider, style = style(14.sp, p.fg, medium = true), maxLines = 1)
                group.take(9).forEach { row ->
                    Row(GlanceModifier.fillMaxWidth().height(22.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(row.window.window, style = style(13.sp, p.fg2), maxLines = 1, modifier = GlanceModifier.width(name))
                        Meter(row, meter, p)
                        Spacer(GlanceModifier.width(12.dp))
                        Text(
                            "${row.percent}%",
                            style = style(13.sp, p.fg, medium = true, align = TextAlign.End),
                            maxLines = 1,
                            modifier = GlanceModifier.width(figure),
                        )
                    }
                }
            }
        }
    }
}

class QuotasWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { Live { store, prefs -> Quotas(store, prefs) } }

    override suspend fun providePreview(context: Context, widgetCategory: Int) = provideContent { Live { store, prefs -> Quotas(store, prefs) } }

    @Composable
    private fun Quotas(store: Store, prefs: Prefs) {
        val context = LocalContext.current
        val phase by store.phase.collectAsState()
        val windows by store.windows.collectAsState()
        val settings by prefs.quota.collectAsState()
        val clock by prefs.clock.collectAsState()
        val colours by prefs.colours.collectAsState()
        val h24 = when (clock) {
            Clock.System -> DateFormat.is24HourFormat(context)
            Clock.H24 -> true
            Clock.H12 -> false
        }
        QuotasWidget(if (phase == Phase.Ready) QuotaRow.of(windows, settings, Instant.now(), h24) else null, Palette.of(colours))
    }
}

class QuotasWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = QuotasWidget()
}

@Composable
private fun Live(content: @Composable (Store, Prefs) -> Unit) {
    val app = LocalContext.current.app()
    content(app.store(), app.prefs())
}

/**
 * Redraws the widgets whenever what they show changes: questions, quota windows, the phase, or a
 * setting they follow. Launchers redraw them every 30 minutes too, for relative times and snoozes
 * that end. On Android 15 and later it also sets the picker's previews, which show the owner's own.
 */
@OptIn(FlowPreview::class)
fun watchWidgets(context: Context, store: Store, prefs: Prefs, scope: CoroutineScope) {
    scope.launch {
        var previewed = false
        combine(listOf(store.phase, store.decisions, store.windows, prefs.colours, prefs.quota, prefs.clock)) { it.toList() }
            .debounce(1_000)
            .collect {
                runCatching {
                    QuestionsWidget().updateAll(context)
                    QuotasWidget().updateAll(context)
                    // The system rate-limits previews: a refused one is tried again on the next change.
                    if (!previewed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                        val manager = GlanceAppWidgetManager(context)
                        val ok = GlanceAppWidgetManager.SET_WIDGET_PREVIEWS_RESULT_SUCCESS
                        previewed = manager.setWidgetPreviews(QuestionsWidgetReceiver::class) == ok &&
                            manager.setWidgetPreviews(QuotasWidgetReceiver::class) == ok
                    }
                }
            }
    }
}

package dev.starbridge.app.widget

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.text.TextPaint
import android.text.format.DateFormat
import android.util.TypedValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.currentState
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
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.di.app
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.day
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
import dev.starbridge.app.ui.weekday
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

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

/** A plan as the Quotas screen groups windows (#160): one provider, on one machine when several upload. */
data class Plan(val provider: String, val machine: String?) {
    val name: String get() = machine?.let { "$provider · $it" } ?: provider

    companion object {
        fun of(window: QuotaWindow) = Plan(window.provider, window.machine)
    }
}

/**
 * The quotas a Quotas widget shows (#907), kept per widget in Glance's state, which goes with the
 * widget: one plan's windows by name, one picked at 2×2 and two at 4×2.
 */
data class Choice(val plan: Plan, val quotas: List<String>) {
    companion object {
        private val PROVIDER = stringPreferencesKey("provider")
        private val MACHINE = stringPreferencesKey("machine")
        private val QUOTAS = stringPreferencesKey("quotas")

        /** Null shows whatever leads the Quotas screen, as a widget did before #907. */
        fun read(state: Preferences): Choice? =
            state[PROVIDER]?.let { Choice(Plan(it, state[MACHINE]), state[QUOTAS].orEmpty().split('\n').filter(String::isNotEmpty)) }

        fun write(state: MutablePreferences, choice: Choice?) {
            state.remove(PROVIDER)
            state.remove(MACHINE)
            state.remove(QUOTAS)
            if (choice == null) return
            state[PROVIDER] = choice.plan.provider
            choice.plan.machine?.let { state[MACHINE] = it }
            state[QUOTAS] = choice.quotas.joinToString("\n")
        }
    }
}

/**
 * The [count] rows a widget with [choice] shows, from its plan's rows in the Quotas screen's
 * order: the picked quotas that still report, then the plan's next ones to fill the room (a 2×2
 * picked one, widened to 4×2). None once no picked quota reports: the widget then says so.
 */
internal fun List<QuotaRow>.chosen(choice: Choice, count: Int): List<QuotaRow> {
    val picked = filter { Plan.of(it.window) == choice.plan && it.window.window in choice.quotas }
    if (picked.isEmpty()) return emptyList()
    return (picked + filter { Plan.of(it.window) == choice.plan && it !in picked }).take(count)
}

/**
 * A window as a widget row: its bar on the owner's scale, where it is headed, and its state in
 * words: the Quotas screen's [word] for the picker, and [words], clearest first, for [Figure] to
 * show the first that fits.
 */
internal class QuotaRow(
    val window: QuotaWindow,
    val bar: QuotaSettings.Bar,
    val course: Course,
    val mood: Mood,
    val word: String,
    val words: List<String>,
) {
    /** The figure and the fill: a window that ran out reads 100% used, as on the Quotas screen. */
    val percent: Int get() = if (course == Course.RanOut && bar.word == "used") 100 else bar.percent.coerceIn(0, 100)

    companion object {
        /**
         * The windows as the Quotas screen orders them, under the owner's quota settings; with a
         * [plan], only its windows, shown even when the Quotas screen hides its provider.
         */
        fun of(windows: List<QuotaWindow>, settings: QuotaSettings, now: Instant, h24: Boolean, plan: Plan? = null): List<QuotaRow> {
            val arranged = if (plan == null) settings.arrange(windows, now)
            else settings.copy(hidden = emptyList()).arrange(windows, now).filter { Plan.of(it) == plan }
            return arranged.map { w ->
                val (mood, word) = w.state(now, settings.absoluteResets, h24)
                val course = w.course(now)
                val at = (w.pace as? Pace.RunsOut)?.at
                QuotaRow(w, settings.bar(w, now), course, mood, word, if (course == Course.Steady || at == null) listOf(word) else outWords(at, now, h24))
            }
        }
    }
}

/**
 * The widget's own words for a window that runs out or ran out (#912), clearest first, each
 * shorter than the last: "Runs out tomorrow 06:44", "Runs out Sat 06:44", "Out Sat 06:44",
 * "Out Sat". The Quotas screen's sentence is cut off in a widget's column. Always a clock time,
 * never "in 3 h": a launcher redraws a widget only every 30 minutes.
 */
internal fun outWords(at: Instant, now: Instant, h24: Boolean, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): List<String> {
    val time = clock(at, h24, zone, locale)
    val today = now.atZone(zone).toLocalDate()
    val date = at.atZone(zone).toLocalDate()
    val near = when (date) {
        today -> "today"
        today.plusDays(1) -> "tomorrow"
        today.minusDays(1) -> "yesterday"
        else -> null
    }
    // Today, the time alone; a weekday names a day within a week either way; further off, the date.
    val far = when {
        date == today -> ""
        abs(ChronoUnit.DAYS.between(today, date)) < 7 -> weekday(at, zone, locale)
        else -> day(at, zone, locale)
    }
    val days = listOfNotNull(near, far)
    val words = if (at.isAfter(now)) days.map { "Runs out $it $time" } + days.map { "Out $it $time" } + days.filter(String::isNotEmpty).map { "Out $it" }
    else days.map { "Ran out $it $time" } + days.map { "Ran out $it" } + "Ran out"
    return words.map { it.replace("  ", " ").trim() }.distinct()
}

/** How wide [text] sets in the widgets' sans (Glance's FontWeight.Medium is sans-serif-medium), under the phone's font scale. */
internal fun Context.textWidth(text: String, size: TextUnit, medium: Boolean): Dp {
    val metrics = resources.displayMetrics
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size.value, metrics)
        typeface = Typeface.create(if (medium) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
    }
    return (paint.measureText(text) / metrics.density).dp
}

/**
 * The first of [words] that fits [width] whole at [size]. When none does (Polish "Out niedz." at
 * font scale 1.3 in a 2×2 at its narrowest), the last, the shortest, set smaller to fit.
 */
internal fun Context.fitting(words: List<String>, width: Dp, size: TextUnit, medium: Boolean): Pair<String, TextUnit> {
    words.firstOrNull { textWidth(it, size, medium) <= width }?.let { return it to size }
    val last = words.last()
    return last to (floor(size.value * width.value / textWidth(last, size, medium).value * 2) / 2).sp
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
 * and its state. 4×2: every window that fits, under its provider, each a meter and a figure. With
 * a [choice] (#907), the picked quota at 2×2, and at 4×2 two of its plan's side by side, as the 2×2
 * draws one. [rows] is null while this phone is not in an account.
 */
@Composable
internal fun QuotasWidget(rows: List<QuotaRow>?, p: Palette, choice: Choice? = null) {
    val size = LocalSize.current
    val wide = size.width >= 250.dp
    val shown = if (choice != null) rows?.chosen(choice, if (wide) 2 else 1) else rows
    Card(p, open(LocalContext.current, MainActivity.TAB_QUOTAS)) {
        val first = shown?.firstOrNull()
        if (first == null) {
            Text(choice?.plan?.name ?: "Quotas", style = style(14.sp, p.fg2, medium = true), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            Text(
                when {
                    shown == null -> "Not signed in"
                    choice != null -> "Not in your quotas now"
                    else -> "No quotas yet"
                },
                style = style(16.sp, p.fg),
            )
            // The choice stays, for quotas that come back; Reconfigure on a long press changes it.
            if (shown != null && choice != null) Text("Touch and hold to pick again", style = style(13.sp, p.fg2), maxLines = 2)
            return@Card
        }
        val inner = size.width - 36.dp
        if (!wide) {
            // Too narrow for both names (#915), the quota's alone: its meter's colour names the provider.
            val (head, headSize) = LocalContext.current.fitting(listOf("${first.window.provider} · ${first.window.window}", first.window.window), inner, 14.sp, true)
            Text(head, style = style(headSize, p.fg2, medium = true), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            Figure(first, inner, p)
            return@Card
        }
        if (choice != null) {
            Text(choice.plan.name, style = style(14.sp, p.fg2, medium = true), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            val gap = 24.dp
            val half = (inner - gap) / 2
            Row(GlanceModifier.fillMaxWidth()) {
                shown.forEachIndexed { i, row ->
                    if (i > 0) Spacer(GlanceModifier.width(gap))
                    Column(GlanceModifier.width(half)) {
                        Text(row.window.window, style = style(13.sp, p.fg2), maxLines = 1)
                        // 2 dp gaps, under a quota's name: at font scale 1.3 a 4×2 is full.
                        Figure(row, half, p, figure = 34.sp, gap = 2.dp)
                    }
                }
            }
            return@Card
        }
        val name = 64.dp
        val figure = 44.dp
        val meter = inner - name - figure - 12.dp
        // Whole providers and rows while they fit: a heading 20 dp, a row 22 dp, 6 dp between providers.
        var room = size.height - 36.dp
        val groups = shown.groupBy { it.window.provider to it.window.machine }.values.mapNotNull { group ->
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
                Text(Plan.of(group.first().window).name, style = style(14.sp, p.fg, medium = true), maxLines = 1)
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

/** A quota as the 2×2 draws it: its figure, its meter and its state, in the clearest words that fit [width]. */
@Composable
private fun Figure(row: QuotaRow, width: Dp, p: Palette, figure: TextUnit = 45.sp, gap: Dp = 4.dp) {
    val context = LocalContext.current
    // Set smaller where "100%" is wider than the column: a 2×2 at its 110 dp minimum (#915).
    val (percent, percentSize) = context.fitting(listOf("${row.percent}%"), width, figure, true)
    Text(percent, style = style(percentSize, p.fg, medium = true), maxLines = 1)
    Spacer(GlanceModifier.height(gap))
    Meter(row, width, p)
    Spacer(GlanceModifier.height(gap))
    val medium = row.mood == Mood.Bad
    val (words, size) = context.fitting(row.words, width, 13.sp, medium)
    Text(words, style = style(size, row.mood.color(p), medium = medium), maxLines = 1)
}

class QuotasWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        Live { store, prefs -> Quotas(store, prefs, Choice.read(currentState())) }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) = provideContent { Live { store, prefs -> Quotas(store, prefs, null) } }

    @Composable
    private fun Quotas(store: Store, prefs: Prefs, choice: Choice?) {
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
        QuotasWidget(if (phase == Phase.Ready) QuotaRow.of(windows, settings, Instant.now(), h24, choice?.plan) else null, Palette.of(colours), choice)
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

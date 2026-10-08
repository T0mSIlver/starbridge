package dev.starbridge.app.widgetmock

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.starbridge.app.R
import dev.starbridge.app.ui.theme.DarkColors
import dev.starbridge.app.ui.theme.DarkProviders
import dev.starbridge.app.ui.theme.LightColors
import dev.starbridge.app.ui.theme.LightProviders
import dev.starbridge.app.ui.theme.StarbridgeColors

// Mockups for #894: three candidate home-screen widgets, on sample data, for the owner to pick
// from. Debug builds only; the picked one is built for real in main.

private fun pair(f: (StarbridgeColors) -> Color) = ColorProvider(day = f(LightColors), night = f(DarkColors))

/** The tokens as day/night providers, so the widget follows the system's dark theme. */
private object C {
    val bg = pair { it.bg }
    val surface = pair { it.surface }
    val surface2 = pair { it.surface2 }
    val fg = pair { it.fg }
    val fg2 = pair { it.fg2 }
    val fg3 = pair { it.fg3 }
    val accent = pair { it.accent }
    val onAccent = pair { it.onAccent }
    val bad = pair { it.bad }
    /** `accent-soft` over `surface`: a whole item that blocks an agent. */
    val amberCard = pair { over(it.accentSoft, it.surface) }
    fun provider(id: String) = ColorProvider(day = LightProviders.getValue(id), night = DarkProviders.getValue(id))
}

private fun over(top: Color, under: Color): Color {
    val a = top.alpha
    return Color(top.red * a + under.red * (1 - a), top.green * a + under.green * (1 - a), top.blue * a + under.blue * (1 - a))
}

private val SANS = FontFamily("google-sans-flex")

private fun style(size: TextUnit, color: ColorProvider, medium: Boolean = false, align: TextAlign? = null) =
    TextStyle(color = color, fontSize = size, fontWeight = if (medium) FontWeight.Medium else FontWeight.Normal, textAlign = align)

private val GROUND = GlanceModifier.fillMaxSize().appWidgetBackground().cornerRadius(28.dp)

private fun GlanceModifier.shape(res: Int, color: ColorProvider) = background(ImageProvider(res), colorFilter = ColorFilter.tint(color))

// ---- Sample data ----

class Q(val question: String, val machine: String, val repo: String, val time: String, val waiting: Boolean, val options: List<String>)

val QUESTIONS = listOf(
    Q("Ship the widget with the questions layout?", "devbox", "starbridge", "2:14", true, listOf("Ship it", "Hold")),
    Q("Which name for the release branch?", "mac", "localvoxtral", "0:41", true, listOf("release/1.4", "v1.4")),
    Q("Retry the flaky e2e on CI or skip it?", "devbox", "vidtheque", "1 h", false, listOf("Retry", "Skip")),
)

class W(val provider: String, val name: String, val window: String, val used: Int, val steady: Int?, val state: String, val runsOut: Boolean, val reset: String)

val WINDOWS = listOf(
    W("claude", "Claude", "Weekly", 68, 55, "Will run out Fri", true, "resets Sat 09:00"),
    W("claude", "Claude", "5-hour", 42, 50, "On pace", false, "resets 14:30"),
    W("codex", "Codex", "Weekly", 51, 47, "On pace", false, "resets Mon 02:00"),
    W("codex", "Codex", "5-hour", 23, 40, "On pace", false, "resets 16:10"),
)

class Rn(val title: String, val machine: String, val elapsed: String, val done: Int?, val total: Int?, val percent: Boolean = false, val failed: String? = null)

val RUNS = listOf<Rn>(
    Rn("Android e2e on the emulator", "devbox", "12 min", 34, 120),
    Rn("Load test, 500 clients", "mac", "3 min", null, null),
    Rn("Release 1.4.0", "devbox", "8 min", null, null, failed = "Failed, exit 1"),
)

// ---- Parts ----

/** A connected button group: the first option the one amber button, the rest tonal. */
@Composable
private fun Options(options: List<String>, tonal: ColorProvider, more: Int = 0) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        options.take(3).forEachIndexed { i, o ->
            val res = when {
                options.size == 1 -> R_BTN_SINGLE
                i == 0 -> R_BTN_START
                i == options.lastIndex -> R_BTN_END
                else -> R_BTN_MID
            }
            if (i > 0) Spacer(GlanceModifier.width(2.dp))
            Box(
                GlanceModifier.defaultWeight().height(40.dp).shape(res, if (i == 0) C.accent else tonal),
                contentAlignment = Alignment.Center,
            ) { Text(o, style = style(14.sp, if (i == 0) C.onAccent else C.fg, medium = true), maxLines = 1) }
        }
        if (more > 0) {
            Spacer(GlanceModifier.width(8.dp))
            Box(GlanceModifier.width(48.dp).height(40.dp).shape(R_BTN_SINGLE, tonal), contentAlignment = Alignment.Center) {
                Text("+$more", style = style(14.sp, C.fg, medium = true))
            }
        }
    }
}

private val R_BTN_SINGLE = R.drawable.mock_btn_single
private val R_BTN_START = R.drawable.mock_btn_start
private val R_BTN_MID = R.drawable.mock_btn_mid
private val R_BTN_END = R.drawable.mock_btn_end

@Composable
private fun MetaRow(left: String, right: String, rightColor: ColorProvider, rightMedium: Boolean) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(left, style = style(13.sp, C.fg2), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        Text(right, style = style(13.sp, rightColor, medium = rightMedium), maxLines = 1)
    }
}

/** The top question as a card: meta row with its clock, the question, its options. */
@Composable
private fun QuestionCard(q: Q, more: Int, modifier: GlanceModifier, padding: Dp) {
    Column(modifier.padding(padding)) {
        MetaRow("${q.machine} · ${q.repo}", q.time, if (q.waiting) C.accent else C.fg2, q.waiting)
        Spacer(GlanceModifier.height(6.dp))
        Text(q.question, style = style(18.sp, C.fg, medium = q.waiting), maxLines = 2)
        Spacer(GlanceModifier.defaultWeight())
        Options(q.options, if (q.waiting) C.surface else C.surface2, more)
    }
}

// ---- Questions ----

class QuestionsMock(private val rest: Boolean = false) : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { Questions(if (rest) emptyList() else QUESTIONS) }
}

@Composable
private fun Questions(qs: List<Q>) {
    val size = LocalSize.current
    val waiting = qs.count { it.waiting }
    when {
        size.width < 250.dp -> {
            // 2x2: the count, amber only when an agent waits.
            Column(GROUND.background(if (waiting > 0) C.amberCard else C.surface).padding(18.dp)) {
                Text("Needs you", style = style(14.sp, C.fg2, medium = true))
                Spacer(GlanceModifier.defaultWeight())
                Text(if (waiting > 0) "$waiting" else "${qs.size}", style = style(57.sp, if (waiting > 0) C.accent else C.fg, medium = true))
                Text(
                    when {
                        waiting > 0 -> "waiting on you"
                        qs.isEmpty() -> "nothing open"
                        else -> "open"
                    },
                    style = style(16.sp, C.fg),
                )
                val rest = qs.size - waiting
                Text(if (waiting > 0 && rest > 0) "$rest more when you can" else " ", style = style(13.sp, C.fg2), maxLines = 1)
            }
        }
        size.height < 230.dp -> {
            // 4x2: the widget is the top question's card.
            val top = qs.first()
            QuestionCard(top, qs.size - 1, GROUND.background(if (top.waiting) C.amberCard else C.surface), 18.dp)
        }
        else -> {
            // 4x3: a header, the top question's card, then the next ones as joined rows.
            Column(GROUND.background(C.bg).padding(12.dp)) {
                Row(GlanceModifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 8.dp, top = 2.dp)) {
                    Text("Needs you", style = style(16.sp, C.fg, medium = true), modifier = GlanceModifier.defaultWeight())
                    if (waiting > 0) Text("$waiting waiting", style = style(14.sp, C.accent, medium = true))
                }
                val top = qs.first()
                QuestionCard(
                    top, 0,
                    GlanceModifier.fillMaxWidth().height(142.dp).shape(R.drawable.mock_seg_top, if (top.waiting) C.amberCard else C.surface),
                    16.dp,
                )
                qs.drop(1).take(1).forEach { q ->
                    Spacer(GlanceModifier.height(2.dp))
                    Column(GlanceModifier.fillMaxWidth().shape(R.drawable.mock_seg_bottom, if (q.waiting) C.amberCard else C.surface).padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text(q.question, style = style(15.sp, C.fg, medium = q.waiting), maxLines = 1)
                        MetaRow("${q.machine} · ${q.repo}", if (qs.size > 2) "+${qs.size - 2} more · ${q.time}" else q.time, if (q.waiting) C.accent else C.fg2, q.waiting)
                    }
                }
            }
        }
    }
}

// ---- Quotas ----

class QuotasMock(private val calm: Boolean = false) : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { Quotas(if (calm) WINDOWS.drop(1) else WINDOWS) }
}

/**
 * The quota meter of the app (ui/quotas/Meter.kt) in boxes: the fill in the lab colour, a gap,
 * the track; the pace tick in `fg`; a red cap at the limit when the window will run out.
 */
@Composable
private fun Meter(w: W, width: Dp) {
    val h = 8.dp
    val reach = 16.dp
    val fill = width * (w.used / 100f)
    Box(GlanceModifier.width(width).height(reach), contentAlignment = Alignment.CenterStart) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(GlanceModifier.width(fill - 2.dp).height(h).cornerRadius(4.dp).background(C.provider(w.provider))) {}
            Spacer(GlanceModifier.width(4.dp))
            Box(GlanceModifier.width(width - fill - 2.dp).height(h).cornerRadius(4.dp).background(C.surface2)) {}
        }
        if (w.runsOut) Row {
            Spacer(GlanceModifier.width(width - 3.dp))
            Box(GlanceModifier.width(3.dp).height(reach).cornerRadius(2.dp).background(C.bad)) {}
        }
        w.steady?.let {
            Row {
                Spacer(GlanceModifier.width(width * (it / 100f) - 1.dp))
                Box(GlanceModifier.width(3.dp).height(reach).cornerRadius(2.dp).background(C.fg)) {}
            }
        }
    }
}

@Composable
private fun Quotas(ws: List<W>) {
    val size = LocalSize.current
    when {
        size.width < 250.dp -> {
            // 2x2: the window that runs out first, as a figure.
            val w = ws.first()
            Column(GROUND.background(C.surface).padding(18.dp)) {
                Text("${w.name} · ${w.window}", style = style(14.sp, C.fg2, medium = true), maxLines = 1)
                Spacer(GlanceModifier.defaultWeight())
                Text("${w.used}%", style = style(45.sp, C.fg, medium = true))
                Spacer(GlanceModifier.height(6.dp))
                Meter(w, size.width - 36.dp)
                Spacer(GlanceModifier.height(6.dp))
                Text(w.state, style = style(13.sp, if (w.runsOut) C.bad else C.fg2, medium = w.runsOut), maxLines = 1)
            }
        }
        else -> {
            // 4x2 and up: windows under their provider; the taller size adds the state and reset.
            val tall = size.height >= 230.dp
            Column(GROUND.background(C.surface).padding(horizontal = 18.dp, vertical = 14.dp)) {
                val name = 64.dp
                val figure = 44.dp
                val meter = size.width - 36.dp - name - figure - 12.dp
                ws.groupBy { it.name }.entries.forEachIndexed { gi, (provider, rows) ->
                    if (gi > 0) Spacer(GlanceModifier.height(if (tall) 10.dp else 6.dp))
                    Column {
                    Text(provider, style = style(14.sp, C.fg, medium = true))
                    rows.forEach { w ->
                        Spacer(GlanceModifier.height(if (tall) 6.dp else 2.dp))
                        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(w.window, style = style(13.sp, C.fg2), maxLines = 1, modifier = GlanceModifier.width(name))
                            Meter(w, meter)
                            Spacer(GlanceModifier.width(12.dp))
                            Text("${w.used}%", style = style(13.sp, C.fg, medium = true, align = TextAlign.End), modifier = GlanceModifier.width(figure))
                        }
                        if (tall) Row(GlanceModifier.fillMaxWidth().padding(start = name)) {
                            Text(w.state, style = style(12.sp, if (w.runsOut) C.bad else C.fg2, medium = w.runsOut), maxLines = 1)
                            Text(" · ${w.reset}", style = style(12.sp, C.fg2), maxLines = 1)
                        }
                    }
                    }
                }
            }
        }
    }
}

// ---- Runs ----

class RunsMock : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { Runs(RUNS) }
}

/** The run card's bar: the fill in `fg`, a gap, the track; Material's indeterminate bar with no progress. */
@Composable
private fun Bar(r: Rn, width: Dp) {
    val h = 6.dp
    if (r.done == null || r.total == null) {
        // Glance's indeterminate bar ignores its colours: a still stand-in for the mockup.
        Row {
            Box(GlanceModifier.width(width * 0.3f).height(h).cornerRadius(3.dp).background(C.surface2)) {}
            Spacer(GlanceModifier.width(6.dp))
            Box(GlanceModifier.width(width * 0.3f).height(h).cornerRadius(3.dp).background(C.fg)) {}
            Spacer(GlanceModifier.width(6.dp))
            Box(GlanceModifier.width(width * 0.4f - 12.dp).height(h).cornerRadius(3.dp).background(C.surface2)) {}
        }
        return
    }
    val fill = width * (r.done.toFloat() / r.total)
    Row {
        Box(GlanceModifier.width(fill).height(h).cornerRadius(3.dp).background(C.fg)) {}
        Spacer(GlanceModifier.width(6.dp))
        Box(GlanceModifier.width(width - fill - 6.dp).height(h).cornerRadius(3.dp).background(C.surface2)) {}
    }
}

private fun Rn.progress() = when {
    failed != null -> failed
    done == null || total == null -> elapsed
    percent -> "$done%"
    else -> "$done of $total"
}

@Composable
private fun RunRow(r: Rn, width: Dp, titleSize: TextUnit) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(r.title, style = style(titleSize, C.fg, medium = true), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        Spacer(GlanceModifier.width(8.dp))
        Text(r.progress(), style = style(13.sp, if (r.failed != null) C.bad else C.fg2, medium = r.failed != null), maxLines = 1)
    }
    if (r.failed == null) {
        Spacer(GlanceModifier.height(8.dp))
        Bar(r, width)
    }
}

@Composable
private fun Runs(rs: List<Rn>) {
    val size = LocalSize.current
    when {
        size.height < 120.dp -> Column(GROUND.background(C.surface).padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            // 4x1: the newest running run.
            RunRow(rs.first(), size.width - 40.dp, 15.sp)
        }
        size.width < 250.dp -> {
            // 2x2: the newest running run, its progress as a figure.
            val r = rs.first()
            Column(GROUND.background(C.surface).padding(18.dp)) {
                Text("Runs · ${rs.count { it.failed == null }}", style = style(14.sp, C.fg2, medium = true))
                Spacer(GlanceModifier.height(6.dp))
                Text(r.title, style = style(16.sp, C.fg, medium = true), maxLines = 2)
                Spacer(GlanceModifier.defaultWeight())
                Text("${r.done} of ${r.total}", style = style(24.sp, C.fg, medium = true))
                Spacer(GlanceModifier.height(8.dp))
                Bar(r, size.width - 36.dp)
                Spacer(GlanceModifier.height(8.dp))
                Text("${r.machine} · ${r.elapsed}", style = style(13.sp, C.fg2), maxLines = 1)
            }
        }
        else -> Column(GROUND.background(C.surface).padding(horizontal = 20.dp, vertical = 14.dp)) {
            // 4x2: running runs, then the ones that ended in the last 30 minutes.
            Row(GlanceModifier.fillMaxWidth()) {
                Text("Runs", style = style(16.sp, C.fg, medium = true), modifier = GlanceModifier.defaultWeight())
                Text("${rs.count { it.failed == null }} running", style = style(14.sp, C.fg2))
            }
            rs.forEach { r ->
                Spacer(GlanceModifier.height(10.dp))
                Column { RunRow(r, size.width - 40.dp, 14.sp) }
            }
        }
    }
}

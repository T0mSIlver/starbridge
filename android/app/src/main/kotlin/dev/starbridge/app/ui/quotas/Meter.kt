package dev.starbridge.app.ui.quotas

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.StarbridgeTheme

/** Where a window is headed, as its meter draws it. */
enum class Course { Steady, WillRunOut, RanOut }

/**
 * A window's use (DESIGN.md, "Quota bars"): the fill in the provider's lab colour, then a gap and
 * the track with its stop dot. A window that will run out waves, and the part the current pace
 * uses before the reset is hatched in the lab colour up to a red cap at the limit; one that ran
 * out is full, with the cap. The pace tick marks where a steady pace would be now; workday ticks
 * cut the bar in the card's colour.
 */
@Composable
fun Meter(bar: QuotaSettings.Bar, course: Course, provider: Color, showUsed: Boolean, card: Color, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val colors = StarbridgeTheme.colors
    // Ran out: full when the bar shows use, empty when it shows what's left.
    val target = if (course == Course.RanOut && showUsed) 1f else bar.percent / 100f
    val fill by animateFloatAsState(target.coerceIn(0f, 1f), MaterialTheme.motionScheme.slowSpatialSpec(), label = "fill")
    val description = "${bar.percent}% ${bar.word}" + (bar.steady?.let { ", steady pace $it%" } ?: "")
    val track = scheme.surfaceContainerHighest
    val pace = scheme.onSurface
    // Ten dp tall; the pace tick and the cap reach 5 dp past it each way, drawn outside the bounds.
    Canvas(modifier.fillMaxWidth().height(Sizes.track).semantics { contentDescription = description }) {
        val h = Sizes.track.toPx()
        val top = 0f
        val reach = h / 2
        val r = CornerRadius(h / 2)
        val w = size.width
        val gap = Sizes.cap.toPx()
        val x = fill * w
        val burning = course == Course.WillRunOut
        val full = fill >= 1f
        // The track starts a gap after the fill, as Material's progress indicator does.
        val trackStart = if (x > 0f) x + gap else 0f
        if (!full && trackStart < w) drawRoundRect(track, Offset(trackStart, top), Size(w - trackStart, h), r)
        val fillEnd = if (full) w else (x - 2.dp.toPx()).coerceAtLeast(0f)
        if (fillEnd > 0f) {
            if (burning && showUsed) wave(provider, fillEnd, top + h / 2) else drawRoundRect(provider, Offset(0f, top), Size(fillEnd, h), r)
        }
        if (burning) {
            // Used: the overrun follows the fill. Left: what's left is the part the pace burns.
            if (showUsed) hatch(provider.copy(alpha = 0.9f), trackStart, w, top, h)
            else hatch(card.copy(alpha = 0.55f), 0f, fillEnd, top, h)
        }
        if (bar.ticks.isNotEmpty()) {
            val tw = Sizes.cap.toPx()
            bar.ticks.forEach { t -> drawRect(card, Offset(t * w - tw / 2, top), Size(tw, h)) }
        }
        if (course == Course.Steady && !full) {
            val d = Sizes.cap.toPx()
            drawCircle(colors.fg3, d / 2, Offset(w - 3.dp.toPx() - d / 2, top + 3.dp.toPx() + d / 2))
        }
        if (course != Course.Steady) {
            val cw = Sizes.cap.toPx()
            val cx = if (showUsed) w - cw / 2 else -cw / 2
            drawRoundRect(colors.bad, Offset(cx, -reach), Size(cw, h + 2 * reach), CornerRadius(cw / 2))
        }
        if (course != Course.RanOut) bar.steady?.let {
            val tw = Sizes.cap.toPx()
            drawRoundRect(pace, Offset(it / 100f * w - tw / 2, -reach), Size(tw, h + 2 * reach), CornerRadius(tw / 2))
        }
    }
}

/** M3 Expressive's wavy indicator: "running now". Period 20 dp, amplitude 3 dp, 4 dp stroke. */
private fun DrawScope.wave(color: Color, end: Float, mid: Float) {
    val period = 20.dp.toPx()
    val amp = 3.dp.toPx()
    val path = Path().apply {
        moveTo(0f, mid)
        var x = 0f
        while (x < end) {
            quadraticTo(x + period / 4, mid - amp * 2, x + period / 2, mid)
            quadraticTo(x + period * 3 / 4, mid + amp * 2, x + period, mid)
            x += period
        }
    }
    val stroke = 4.dp.toPx()
    clipRect(0f, -size.height, end, size.height * 2) { drawPath(path, color, style = Stroke(stroke, cap = StrokeCap.Round)) }
}

/** Stripes rising at 45°, [Sizes.hatch] apart, 2 dp wide, in a rounded bar from [from] to [to]. */
private fun DrawScope.hatch(color: Color, from: Float, to: Float, top: Float, h: Float) {
    if (to <= from) return
    val clip = Path().apply { addRoundRect(RoundRect(from, top, to, top + h, CornerRadius(h / 2))) }
    // Stripes [Sizes.hatch] apart across the stripe are √2 times that apart along the bar.
    val step = Sizes.hatch.toPx() * 1.4142f
    clipPath(clip) {
        var x = from - h
        while (x < to) {
            drawLine(color, Offset(x, top + h), Offset(x + h, top), strokeWidth = 2.dp.toPx())
            x += step
        }
    }
}

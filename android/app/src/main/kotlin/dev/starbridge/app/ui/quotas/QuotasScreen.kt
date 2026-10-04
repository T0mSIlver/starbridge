package dev.starbridge.app.ui.quotas

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.SpanStyle
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.Refreshable
import dev.starbridge.app.ui.Screen
import dev.starbridge.app.ui.StatusWord
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.span
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class QuotasViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val windows = store.windows
    fun refresh() = store.refresh()
}

/** One card per window; windows with an alert come first. */
@Composable
fun QuotasScreen(windows: List<QuotaWindow>, now: Instant, modifier: Modifier = Modifier, refresh: Refresh? = null) {
    Screen("Quotas", modifier) { padding ->
        Refreshable(refresh) {
            LazyColumn(
                contentPadding = listPadding(padding),
                verticalArrangement = Arrangement.spacedBy(Spacing.s3),
            ) {
                if (windows.isEmpty()) {
                    item {
                        Text(
                            "No quota snapshots yet. A paired machine sends them with starbridge quota push.",
                            style = StarbridgeTheme.type.body,
                            color = StarbridgeTheme.colors.fg2,
                            modifier = Modifier.padding(horizontal = Spacing.s1),
                        )
                    }
                }
                items(windows.sortedByDescending { it.alert }, key = { it.id }) { WindowCard(it, now, Modifier.animateItem()) }
            }
        }
    }
}

/** A pace's colour and word; DESIGN.md: never colour without the word. */
private class Tone(val color: Color, val word: String)

@Composable
private fun tone(pace: Pace): Tone {
    val c = StarbridgeTheme.colors
    return when (pace) {
        Pace.Even -> Tone(c.ok, "On pace")
        is Pace.RunsOut -> Tone(c.bad, "Will run out")
        is Pace.Unused -> Tone(c.warn, "Headroom unused")
        Pace.Unknown -> Tone(c.fg3, "Too early to tell")
    }
}

@Composable
private fun WindowCard(window: QuotaWindow, now: Instant, modifier: Modifier = Modifier) {
    val colors = StarbridgeTheme.colors
    val tone = tone(window.pace)
    Panel(modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                buildAnnotatedString {
                    append(window.provider)
                    withStyle(SpanStyle(color = colors.fg2, fontWeight = StarbridgeTheme.type.small.fontWeight)) { append("  ${window.window}") }
                },
                style = StarbridgeTheme.type.action,
                color = colors.fg,
                modifier = Modifier.weight(1f).padding(bottom = Spacing.s1),
            )
            Text(
                buildAnnotatedString {
                    append("${window.usedPercent}")
                    withStyle(SpanStyle(color = colors.fg2, fontSize = StarbridgeTheme.type.action.fontSize)) { append("%") }
                },
                style = StarbridgeTheme.type.figure,
                color = colors.fg,
            )
        }
        Spacer(Modifier.padding(top = Spacing.s3))
        Meter(window, tone.color)
        Spacer(Modifier.padding(top = Spacing.s3))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusWord(tone.word, tone.color)
            Spacer(Modifier.width(Spacing.s3))
            Text(
                window.resetsAt?.let { "Resets in ${span(now, it)}" } ?: "Reset time unknown",
                style = StarbridgeTheme.type.machine,
                color = colors.fg2,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.End,
            )
        }
        Text(detail(window, now), style = StarbridgeTheme.type.small, color = if (window.alert) tone.color else colors.fg2, modifier = Modifier.padding(top = Spacing.s2))
    }
}

/**
 * The window's use as a Material 3 Expressive progress indicator, `size.track` thick, with its gap
 * and stop mark, and a tick where a steady pace would be now. The fill springs to a new value.
 */
@Composable
private fun Meter(window: QuotaWindow, color: Color) {
    val colors = StarbridgeTheme.colors
    val used by animateFloatAsState((window.usedPercent / 100f).coerceIn(0f, 1f), MaterialTheme.motionScheme.slowSpatialSpec(), label = "used")
    val description = "${window.usedPercent}% used" + (window.steadyPercent?.let { ", steady pace $it%" } ?: "")
    BoxWithConstraints(Modifier.fillMaxWidth().semantics { contentDescription = description }) {
        LinearProgressIndicator(
            progress = { used },
            modifier = Modifier.fillMaxWidth().height(Sizes.track).align(Alignment.Center),
            color = color,
            trackColor = colors.surface2,
            strokeCap = StrokeCap.Round,
            gapSize = ProgressIndicatorDefaults.LinearIndicatorTrackGapSize,
            drawStopIndicator = {
                ProgressIndicatorDefaults.drawStopIndicator(this, ProgressIndicatorDefaults.LinearTrackStopIndicatorSize, colors.fg3, StrokeCap.Round)
            },
        )
        window.steadyPercent?.let { steady ->
            val tick = Spacing.s1 / 2
            Box(
                Modifier
                    .offset(x = (maxWidth - tick) * (steady / 100f))
                    .width(tick)
                    .height(Sizes.track + Spacing.s2)
                    .align(Alignment.CenterStart)
                    .background(colors.fg2, RoundedCornerShape(Radius.xs)),
            )
        }
    }
}

private fun detail(window: QuotaWindow, now: Instant): String = when (val pace = window.pace) {
    Pace.Even -> "Lasts until the reset"
    is Pace.RunsOut -> "Runs out in ${span(now, pace.at)}" + (window.resetsAt?.let { ", ${span(pace.at, it)} before the reset" } ?: "")
    is Pace.Unused -> "${pace.percent}% left unused at the reset"
    Pace.Unknown -> "Too early in the window to tell the pace"
}

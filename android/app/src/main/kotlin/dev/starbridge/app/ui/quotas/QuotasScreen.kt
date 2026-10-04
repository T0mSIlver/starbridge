package dev.starbridge.app.ui.quotas

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.span
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class QuotasViewModel @Inject constructor(store: Store) : ViewModel() {
    val windows = store.windows
}

/** One card per window; windows about to reset with headroom unused come first. */
@Composable
fun QuotasScreen(windows: List<QuotaWindow>, now: Instant, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        item { Title("Quotas") }
        items(windows.sortedByDescending { it.alert }, key = { it.id }) { WindowCard(it, now) }
    }
}

private class Tone(val color: Color, val soft: Color, val word: String)

@Composable
private fun tone(pace: Pace): Tone {
    val c = StarbridgeTheme.colors
    return when (pace) {
        Pace.Even -> Tone(c.ok, c.okSoft, "on pace")
        is Pace.RunsOut -> Tone(c.bad, c.badSoft, "will run out")
        is Pace.Unused -> Tone(c.warn, c.warnSoft, "unused")
    }
}

@Composable
private fun WindowCard(window: QuotaWindow, now: Instant) {
    val colors = StarbridgeTheme.colors
    val tone = tone(window.pace)
    Panel(Modifier.fillMaxWidth(), border = if (window.alert) tone.color else colors.line) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(window.provider, style = StarbridgeTheme.type.heading, color = colors.fg)
            Spacer(Modifier.padding(start = Spacing.s2))
            Text(window.window, style = StarbridgeTheme.type.small, color = colors.fg2)
            Spacer(Modifier.weight(1f))
            Text("${window.usedPercent}%", style = StarbridgeTheme.type.figure, color = colors.fg)
        }
        Spacer(Modifier.padding(top = Spacing.s3))
        LinearProgressIndicator(
            progress = { window.usedPercent / 100f },
            modifier = Modifier.fillMaxWidth(),
            color = tone.color,
            trackColor = colors.surface2,
            strokeCap = StrokeCap.Round,
            drawStopIndicator = {},
        )
        Spacer(Modifier.padding(top = Spacing.s3))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = RoundedCornerShape(Radius.pill), color = tone.soft) {
                Label(tone.word, Modifier.padding(horizontal = Spacing.s2, vertical = Spacing.s1), color = tone.color)
            }
            Spacer(Modifier.padding(start = Spacing.s2))
            Text(detail(window, now), style = StarbridgeTheme.type.small, color = colors.fg2, modifier = Modifier.weight(1f))
        }
        Text("Resets in ${span(now, window.resetsAt)}", style = StarbridgeTheme.type.machine, color = colors.fg3, modifier = Modifier.padding(top = Spacing.s2))
        if (window.alert) {
            Box(Modifier.padding(top = Spacing.s3)) {
                Text("Resets soon with headroom left: spend it before it's gone.", style = StarbridgeTheme.type.small, color = tone.color)
            }
        }
    }
}

private fun detail(window: QuotaWindow, now: Instant): String = when (val pace = window.pace) {
    Pace.Even -> "Lasts until the reset"
    is Pace.RunsOut -> "Runs out in ${span(now, pace.at)}, ${span(pace.at, window.resetsAt)} before the reset"
    is Pace.Unused -> "${pace.percent}% left unused at the reset"
}

package dev.starbridge.app.ui.inbox

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.data.Run
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.elapsed
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant

/**
 * A run: the meta row with its time, what it is and why the owner hears of it, its progress while
 * it runs, then how it ended. No amber: a run needs nobody.
 */
@Composable
fun RunCard(run: Run, now: Instant, shape: Shape, modifier: Modifier = Modifier, onDismiss: (() -> Unit)? = null) {
    val scheme = MaterialTheme.colorScheme
    val colors = StarbridgeTheme.colors
    val type = StarbridgeTheme.type
    val state = run.state(now)
    // A lost run's length is unknown: its last news may predate its end by minutes (#190).
    val time = when (state) {
        Run.State.Running -> waited(run.startedAt, now)
        Run.State.Lost -> ""
        else -> elapsed(run.startedAt, run.endedAt ?: run.at)
    }
    Surface(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, shape = shape, color = scheme.surfaceContainer) {
        Column(Modifier.padding(Spacing.s5), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            MetaRow(run.source, time)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Symbol(Sym.Play, size = 12.dp, filled = true, tint = scheme.onSurface)
                Spacer(Modifier.width(Spacing.s2))
                Text(run.title, style = type.action.copy(lineHeight = 22.sp), color = scheme.onSurface)
            }
            Text(run.reason.replaceFirstChar { it.uppercase() }, style = type.small, color = scheme.onSurfaceVariant)
            if (state == Run.State.Running) run.progress?.let { Progress(it) } ?: Working()
            else Row(verticalAlignment = Alignment.CenterVertically) {
                val (text, color) = when (state) {
                    Run.State.Passed -> "Passed" to colors.ok
                    Run.State.Failed -> "Failed, exit ${run.exitCode}" to colors.bad
                    else -> "Lost, no news for ${elapsed(run.at, now)}" to colors.fg3
                }
                Text(text, style = type.metaStrong, color = color, modifier = Modifier.weight(1f))
                // Tonal, as a card's secondary buttons are (DESIGN.md); it drops the run on every device (#827).
                if (onDismiss != null) FilledTonalButton(
                    onClick = onDismiss,
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surface2, contentColor = scheme.onSurface),
                    modifier = Modifier.heightIn(min = Sizes.tap),
                ) { Text("Dismiss", style = type.action) }
            }
        }
    }
}

/** No progress reported: Material's indeterminate bar, in the same colours as [Progress]. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Working() {
    LinearProgressIndicator(
        color = MaterialTheme.colorScheme.onSurface,
        trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        modifier = Modifier.fillMaxWidth().padding(top = Spacing.s1).height(6.dp).semantics { contentDescription = "Running" },
    )
}

/** The fill in `fg`, a gap, then the track, as Material's indicator; "3 of 7" under it. */
@Composable
private fun Progress(p: Run.Progress) {
    val scheme = MaterialTheme.colorScheme
    val fraction by animateFloatAsState(p.fraction.coerceIn(0f, 1f), MaterialTheme.motionScheme.slowSpatialSpec(), label = "progress")
    Column(Modifier.padding(top = Spacing.s1), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().height(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (fraction > 0f) Box(Modifier.weight(fraction).height(6.dp).background(scheme.onSurface, RoundedCornerShape(3.dp)))
            if (fraction < 1f) Box(Modifier.weight(1f - fraction).height(6.dp).background(scheme.surfaceContainerHighest, RoundedCornerShape(3.dp)))
        }
        Text(if (p.percent) "${p.done}%" else "${p.done} of ${p.total}", style = StarbridgeTheme.type.caption, color = scheme.onSurfaceVariant)
    }
}


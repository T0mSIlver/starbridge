package dev.starbridge.app.ui.inbox

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import dev.starbridge.app.data.Run
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.StatusWord
import dev.starbridge.app.ui.elapsed
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant

/**
 * A run: what it is and why the owner hears of it, its time and progress while it runs, then pass
 * or fail with the duration. No amber: a run needs nobody.
 */
@Composable
fun RunCard(run: Run, now: Instant, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val colors = StarbridgeTheme.colors
    val type = StarbridgeTheme.type
    val state = run.state(now)
    val took = elapsed(run.startedAt, run.endedAt ?: run.at)
    Panel(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, color = scheme.surfaceContainer) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Text(run.title, style = type.action, color = scheme.onSurface, modifier = Modifier.weight(1f))
            when (state) {
                Run.State.Running -> Text(elapsed(run.startedAt, now), style = type.label, color = scheme.onSurfaceVariant)
                Run.State.Passed -> StatusWord("Passed", colors.ok)
                Run.State.Failed -> StatusWord("Failed, exit ${run.exitCode}", colors.bad)
                Run.State.Lost -> StatusWord("No news", colors.fg3)
            }
        }
        Text(run.reason, style = type.small, color = scheme.onSurfaceVariant, modifier = Modifier.padding(top = Spacing.s1))
        if (state == Run.State.Running) Progress(run)
        Row(Modifier.padding(top = Spacing.s2), horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Text(
                listOf(run.source.machine, run.source.title ?: run.source.project).filter { it.isNotBlank() }.joinToString(" · "),
                style = type.machine,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            val right = when (state) {
                Run.State.Running -> run.progress?.text
                Run.State.Lost -> "for ${elapsed(run.at, now)}"
                else -> took
            }
            right?.let { Text(it, style = type.machine, color = scheme.onSurfaceVariant) }
        }
    }
}

/** Material 3 Expressive's linear indicator, as on quota cards; indeterminate without a value. */
@Composable
private fun Progress(run: Run) {
    val scheme = MaterialTheme.colorScheme
    val fg3 = StarbridgeTheme.colors.fg3
    val bar = Modifier.fillMaxWidth().padding(top = Spacing.s3).height(Sizes.track)
    val p = run.progress
    if (p == null) {
        LinearProgressIndicator(modifier = bar, color = scheme.onSurface, trackColor = scheme.surfaceContainerHigh, strokeCap = StrokeCap.Round)
        return
    }
    val fraction by animateFloatAsState(p.fraction.coerceIn(0f, 1f), MaterialTheme.motionScheme.slowSpatialSpec(), label = "progress")
    LinearProgressIndicator(
        progress = { fraction },
        modifier = bar,
        color = scheme.onSurface,
        trackColor = scheme.surfaceContainerHigh,
        strokeCap = StrokeCap.Round,
        gapSize = ProgressIndicatorDefaults.LinearIndicatorTrackGapSize,
        drawStopIndicator = {
            ProgressIndicatorDefaults.drawStopIndicator(this, ProgressIndicatorDefaults.LinearTrackStopIndicatorSize, fg3, StrokeCap.Round)
        },
    )
}

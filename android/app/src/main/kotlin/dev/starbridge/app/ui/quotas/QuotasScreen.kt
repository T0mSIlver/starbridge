package dev.starbridge.app.ui.quotas

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.toShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
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
import dev.starbridge.app.ui.ago
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
                if (windows.isEmpty()) item { NoQuotas() }
                items(windows.sortedByDescending { it.alert && !it.ended(now) }, key = { it.id }) { WindowCard(it, now, Modifier.animateItem()) }
            }
        }
    }
}

private const val QUOTA_DOCS = "https://github.com/T0mSIlver/starbridge/tree/main/cli#readme"

/** Nothing uploaded yet: what sends quotas, and how to start it. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun NoQuotas() {
    val context = LocalContext.current
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.s4, vertical = Spacing.s10),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        Box(Modifier.size(Spacing.s10 * 2).background(MaterialTheme.colorScheme.secondaryContainer, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Speed, contentDescription = null, tint = MaterialTheme.colorScheme.secondary, modifier = Modifier.size(Spacing.s10))
        }
        Text("No machine sends quotas yet", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
        Text(
            "On a paired machine with CodexBar, run this. It sends your plans' windows every 5 minutes.",
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
            Text("starbridge quota push", style = StarbridgeTheme.type.code, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(Spacing.s4))
        }
        OutlinedButton(
            onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(QUOTA_DOCS))) } },
            modifier = Modifier.heightIn(min = Sizes.tap),
        ) { Text("How to set it up", style = StarbridgeTheme.type.action) }
    }
}

/**
 * The window reset after this snapshot: its use and pace belong to the window that ended, so the
 * card says so until a machine uploads the new one.
 */
private fun QuotaWindow.ended(now: Instant) = resetsAt?.isAfter(now) == false

/** A pace's colour and word; DESIGN.md: never colour without the word. */
private class Tone(val color: Color, val word: String)

@Composable
private fun tone(window: QuotaWindow, now: Instant): Tone {
    val c = StarbridgeTheme.colors
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    if (window.ended(now)) return Tone(neutral, "Window reset")
    return when (val pace = window.pace) {
        Pace.Even -> Tone(c.ok, "On pace")
        is Pace.RunsOut -> Tone(c.bad, if (pace.at.isAfter(now)) "Will run out" else "Ran out")
        is Pace.Unused -> Tone(c.warn, "Headroom unused")
        Pace.Unknown -> Tone(neutral, "Too early to tell")
    }
}

private const val DOT = "provider"

/** The provider's dot, in its lab's colour, set in the line of text so it stays on the first line. */
@Composable
private fun providerDot(provider: String): Map<String, InlineTextContent> {
    val color = StarbridgeTheme.provider(provider)
    val (width, height) = with(LocalDensity.current) { (Spacing.s2 * 2).toSp() to Spacing.s2.toSp() }
    return mapOf(
        DOT to InlineTextContent(Placeholder(width, height, PlaceholderVerticalAlign.TextCenter)) {
            Box(Modifier.size(Spacing.s2).background(color, CircleShape))
        },
    )
}

@Composable
private fun WindowCard(window: QuotaWindow, now: Instant, modifier: Modifier = Modifier) {
    val tone = tone(window, now)
    val ended = window.ended(now)
    Panel(modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                buildAnnotatedString {
                    appendInlineContent(DOT)
                    append(window.provider)
                    withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = StarbridgeTheme.type.small.fontWeight)) { append("  ${window.window}") }
                    window.machine?.let { withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = StarbridgeTheme.type.small.fontWeight)) { append(" · $it") } }
                },
                style = StarbridgeTheme.type.action,
                color = MaterialTheme.colorScheme.onSurface,
                inlineContent = providerDot(window.provider),
                modifier = Modifier.weight(1f).padding(bottom = Spacing.s1),
            )
            Text(
                buildAnnotatedString {
                    append("${window.usedPercent}")
                    withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = StarbridgeTheme.type.action.fontSize)) { append("%") }
                },
                style = StarbridgeTheme.type.figure,
                color = if (ended) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
        }
        Spacer(Modifier.padding(top = Spacing.s3))
        Meter(window, tone.color)
        Spacer(Modifier.padding(top = Spacing.s3))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusWord(tone.word, tone.color)
            Spacer(Modifier.width(Spacing.s3))
            Text(
                window.resetsAt?.let { if (ended) "Reset ${ago(now, it)}" else "Resets in ${span(now, it)}" } ?: "Reset time unknown",
                style = StarbridgeTheme.type.machine,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.End,
            )
        }
        Text(detail(window, now), style = StarbridgeTheme.type.small, color = if (window.alert && !ended) tone.color else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Spacing.s2))
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
            trackColor = MaterialTheme.colorScheme.secondaryContainer,
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
                    .background(MaterialTheme.colorScheme.onSurfaceVariant, RoundedCornerShape(Radius.xs)),
            )
        }
    }
}

private fun detail(window: QuotaWindow, now: Instant): String = if (window.ended(now)) {
    "Ended at ${window.usedPercent}% used; waiting for the next upload"
} else when (val pace = window.pace) {
    is Pace.RunsOut if !pace.at.isAfter(now) -> window.resetsAt?.let { "Back at the reset, in ${span(now, it)}" } ?: "Back at the reset"
    Pace.Even -> "Lasts until the reset"
    is Pace.RunsOut -> "Runs out in ${span(now, pace.at)}" + (window.resetsAt?.let { ", ${span(pace.at, it)} before the reset" } ?: "")
    is Pace.Unused -> "${pace.percent}% left unused at the reset"
    Pace.Unknown -> "Too early in the window to tell the pace"
}

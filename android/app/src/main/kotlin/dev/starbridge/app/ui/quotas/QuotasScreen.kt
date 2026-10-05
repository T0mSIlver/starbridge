package dev.starbridge.app.ui.quotas

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.cardShape
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.resetClock
import dev.starbridge.app.ui.span
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class QuotasViewModel @Inject constructor(private val store: Store, private val prefs: Prefs) : ViewModel() {
    val windows = store.windows
    val settings = prefs.quota
    fun refresh() = store.refresh()
    fun setSettings(value: QuotaSettings) = prefs.setQuota(value)
}

/** One card per window, hidden providers out; windows that will run out first, then the settings' order. */
@Composable
fun QuotasScreen(
    windows: List<QuotaWindow>,
    now: Instant,
    modifier: Modifier = Modifier,
    settings: QuotaSettings = QuotaSettings(),
    refresh: Refresh? = null,
    /** Turns a provider's notifications on or off, from an alert card. */
    onNotify: (provider: String, on: Boolean) -> Unit = { _, _ -> },
) {
    val shown = settings.arrange(windows, now)
    val updated = windows.mapNotNull { it.takenAt }.maxOrNull()
    Page(
        "Quotas",
        modifier,
        refresh = refresh,
        trailing = updated?.let {
            {
                Text(
                    "Updated ${ago(now, it)}",
                    style = StarbridgeTheme.type.meta,
                    color = StarbridgeTheme.colors.fg3,
                    modifier = Modifier.padding(bottom = Spacing.s2),
                )
            }
        },
    ) {
        if (windows.isEmpty()) item { NoQuotas() }
        else if (shown.isEmpty()) item {
            Text(
                "Every provider is hidden",
                style = StarbridgeTheme.type.body,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(Spacing.s4),
            )
        }
        itemsIndexed(shown, key = { _, it -> it.id }) { i, w ->
            WindowCard(w, now, settings, cardShape(i, shown.size), onNotify = { onNotify(w.provider, it) }, modifier = Modifier.animateItem())
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
        Box(Modifier.size(160.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Symbol(Sym.Speed, size = 56.dp, tint = MaterialTheme.colorScheme.onSurface)
        }
        Text("No quotas yet", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
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

private fun QuotaWindow.course(now: Instant): Course = when (val p = pace) {
    is Pace.RunsOut if !ended(now) -> if (p.at.isAfter(now)) Course.WillRunOut else Course.RanOut
    else -> Course.Steady
}

/** The state in words, coloured; DESIGN.md: the words carry the state, never a colour alone. */
private class Tone(val color: Color, val word: String)

@Composable
private fun tone(window: QuotaWindow, now: Instant): Tone {
    val c = StarbridgeTheme.colors
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    if (window.ended(now)) return Tone(neutral, "Window reset")
    return when (val pace = window.pace) {
        Pace.Even -> Tone(c.ok, "On pace")
        is Pace.RunsOut -> Tone(c.bad, if (pace.at.isAfter(now)) "Will run out in ${span(now, pace.at)}" else "Ran out at ${clock(pace.at)}")
        is Pace.Unused -> Tone(c.warn, "Headroom unused")
        Pace.Unknown -> Tone(neutral, "Too early to tell")
    }
}

/** What "Notify me" turned on, in a few words. */
private fun notifies(settings: QuotaSettings) = when {
    settings.notifyLow && settings.notifyPace -> "When low and before it runs out"
    settings.notifyLow -> "At 50% and 20% left"
    settings.notifyPace -> "Before it runs out"
    else -> ""
}

@Composable
private fun WindowCard(window: QuotaWindow, now: Instant, settings: QuotaSettings, shape: Shape, onNotify: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val type = StarbridgeTheme.type
    val tone = tone(window, now)
    val ended = window.ended(now)
    val course = window.course(now)
    val bar = settings.bar(window, now)
    val card = scheme.surfaceContainer
    Surface(modifier.fillMaxWidth(), shape = shape, color = card) {
        Column(Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            // One 24 dp line: the figure's glyphs are taller than the line they sit on.
            Row(Modifier.height(24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    buildAnnotatedString {
                        append(window.provider)
                        withStyle(SpanStyle(color = scheme.onSurfaceVariant)) {
                            append(" ${window.window}")
                            window.machine?.let { append(" · $it") }
                        }
                    },
                    style = type.body,
                    color = scheme.onSurface,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    buildAnnotatedString {
                        append("${if (course == Course.RanOut && settings.showUsed) 100 else bar.percent}")
                        withStyle(SpanStyle(fontSize = type.label.fontSize, fontWeight = type.label.fontWeight)) { append("%") }
                    },
                    style = type.figure.copy(lineHeight = type.figure.fontSize),
                    color = if (ended) scheme.onSurfaceVariant else scheme.onSurface,
                )
            }
            Meter(bar, course, StarbridgeTheme.provider(window.provider), settings.showUsed, card)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(tone.word, style = type.metaStrong, color = tone.color, maxLines = 1, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(Spacing.s2))
                Text(
                    window.resetsAt?.let { if (ended) "Reset ${ago(now, it)}" else if (settings.absoluteResets) "Resets ${resetClock(it, now)}" else "Resets in ${span(now, it)}" } ?: "Reset time unknown",
                    style = type.meta,
                    color = scheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            // A window that will run out, or one with a headroom alert; one that ran out is past warning.
            if ((course == Course.WillRunOut || window.alert && course == Course.Steady) && !ended) Notify(window.provider in settings.notify, notifies(settings), onNotify)
        }
    }
}

/** "Notify me" on a window that needs watching; "Notifying" once its provider notifies. */
@Composable
private fun Notify(on: Boolean, what: String, onNotify: (Boolean) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column {
        HorizontalDivider(color = scheme.outlineVariant, modifier = Modifier.padding(top = 2.dp))
        Row(Modifier.padding(top = Spacing.s3), verticalAlignment = Alignment.CenterVertically) {
            Text(if (on) what else "", style = StarbridgeTheme.type.meta, color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(Spacing.s3))
            Button(
                onClick = { onNotify(!on) },
                // Neutral either way, under Match wallpaper too: amber is for what needs the owner.
                colors = if (on) ButtonDefaults.buttonColors(containerColor = scheme.onSurface, contentColor = scheme.surface)
                else ButtonDefaults.buttonColors(containerColor = scheme.surfaceContainerHighest, contentColor = scheme.onSurface),
                contentPadding = PaddingValues(horizontal = Spacing.s4),
                modifier = Modifier.height(Spacing.s10),
            ) {
                Symbol(Sym.Bell, size = 18.dp, filled = on)
                Spacer(Modifier.width(Spacing.s2))
                Text(if (on) "Notifying" else "Notify me", style = StarbridgeTheme.type.label)
            }
        }
    }
}

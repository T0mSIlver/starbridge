package dev.starbridge.app.ui.quotas

import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
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
import dev.starbridge.app.data.QuotaFailure
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.cardShape
import dev.starbridge.app.ui.clockAt
import dev.starbridge.app.ui.span
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

@HiltViewModel
class QuotasViewModel @Inject constructor(private val store: Store, private val prefs: Prefs) : ViewModel() {
    val windows = store.windows
    val failures = store.quotaFailures
    val settings = prefs.quota
    val members = store.members
    fun refresh() = store.refreshQuotas()
}

/** One card per provider, its windows inside, in the settings' order (SPEC.md, "Quota order"). */
@Composable
fun QuotasScreen(
    windows: List<QuotaWindow>,
    now: Instant,
    modifier: Modifier = Modifier,
    settings: QuotaSettings = QuotaSettings(),
    refresh: Refresh? = null,
    failures: List<QuotaFailure> = emptyList(),
    /** The account's machines by name; null until the directory has loaded. */
    machines: List<String>? = null,
) {
    val none = windows.isEmpty() && failures.isEmpty()
    // A device that just joined has no snapshot sealed to it yet, and quota items send no push:
    // ask the machines once, as a pull does, instead of waiting for their next upload (#661).
    var asked by rememberSaveable { mutableStateOf(false) }
    val ask = none && !machines.isNullOrEmpty() && refresh != null
    LaunchedEffect(ask) {
        if (ask && !asked) {
            asked = true
            refresh?.run?.invoke()
        }
    }
    val shown = settings.arrange(windows, now)
    val groups = settings.groups(shown)
    val failed = failures.filter { it.provider !in settings.hidden }
    val cards = groups.size + failed.size
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
        if (none) item { NoQuotas(machines, asking = refresh?.busy == true || (ask && !asked)) }
        else if (cards == 0) item {
            Text(
                "Every provider is hidden",
                style = StarbridgeTheme.type.body,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(Spacing.s4),
            )
        }
        itemsIndexed(groups, key = { _, g -> "${g[0].provider}/${g[0].machine}" }) { i, g ->
            val first = g[0]
            ProviderCard(first.provider, first.machine, first.error, first.takenAt, g, now, settings, cardShape(i, cards), modifier = Modifier.animateItem())
        }
        // After the windows: a provider with none to show says only why.
        itemsIndexed(failed, key = { _, f -> "failed/${f.provider}/${f.machine}" }) { i, f ->
            ProviderCard(f.provider, f.machine, f.error, null, emptyList(), now, settings, cardShape(groups.size + i, cards), modifier = Modifier.animateItem())
        }
    }
}

private const val QUOTA_DOCS = "https://starbridge.run/docs/cli"

/**
 * No snapshot yet: whose quotas are on the way, or why none come. [machines] null: the directory
 * has not loaded.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun NoQuotas(machines: List<String>?, asking: Boolean) {
    val context = LocalContext.current
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.s4, vertical = Spacing.s10),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        Box(Modifier.size(160.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Symbol(Sym.Speed, size = 56.dp, tint = MaterialTheme.colorScheme.onSurface)
        }
        val heading = when {
            machines == null -> "No quotas yet"
            machines.isEmpty() -> "No machine yet"
            asking -> "Loading quotas from ${names(machines)}…"
            else -> "No quotas from ${names(machines)}"
        }
        Text(heading, style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
        if (machines != null && machines.isEmpty()) {
            Text("Quotas come from the machines that run your agents. Add one from the Inbox.", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        } else if (machines != null && !asking) {
            Text(
                "A machine uploads quotas once CodexBar reads an AI plan there. Run setup on it and say yes to quotas:",
                style = StarbridgeTheme.type.body,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
                Text("starbridge setup", style = StarbridgeTheme.type.code, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(Spacing.s4))
            }
            OutlinedButton(
                onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(QUOTA_DOCS))) } },
                modifier = Modifier.heightIn(min = Sizes.tap),
            ) { Text("How to set it up", style = StarbridgeTheme.type.action) }
        }
    }
}

/** "devbox", "devbox and laptop", "devbox, laptop and pi". */
internal fun names(machines: List<String>) = when (machines.size) {
    0 -> ""
    1 -> machines[0]
    else -> machines.dropLast(1).joinToString(", ") + " and " + machines.last()
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
private fun tone(window: QuotaWindow, now: Instant, absolute: Boolean): Tone {
    val c = StarbridgeTheme.colors
    val neutral = MaterialTheme.colorScheme.onSurfaceVariant
    val h24 = LocalClock24.current
    if (window.ended(now)) return Tone(neutral, "Window reset")
    return when (val pace = window.pace) {
        Pace.Even -> Tone(c.ok, "On pace")
        is Pace.RunsOut -> Tone(
            c.bad,
            when {
                !pace.at.isAfter(now) -> "Ran out ${clockAt(pace.at, now, h24)}"
                absolute -> "Will run out ${clockAt(pace.at, now, h24)}"
                else -> "Will run out in ${span(now, pace.at)}"
            },
        )
        is Pace.Unused -> Tone(c.warn, "Headroom unused")
        Pace.Unknown -> Tone(neutral, "Too early to tell")
    }
}

/**
 * A provider's name, the machine that sent its windows when there are several, and the windows.
 * When CodexBar failed for it, its last windows stay, and the name says when they were read and
 * why they were not read again. A provider with no windows to keep shows only why (#450).
 */
@Composable
private fun ProviderCard(
    provider: String,
    machine: String?,
    error: String?,
    takenAt: Instant?,
    windows: List<QuotaWindow>,
    now: Instant,
    settings: QuotaSettings,
    shape: Shape,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth(), shape = shape, color = scheme.surfaceContainer) {
        Column(Modifier.padding(Spacing.s4)) {
            // The machine at the end of the provider's line, or on a line of its own when both don't fit.
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
                Text(provider, style = StarbridgeTheme.type.subtitle, color = scheme.onSurface, modifier = Modifier.padding(end = Spacing.s2))
                machine?.let { Text(it, style = StarbridgeTheme.type.meta, color = scheme.onSurfaceVariant) }
            }
            error?.let { error ->
                Column(Modifier.padding(top = Spacing.s1)) {
                    takenAt?.let { Text("Updated ${ago(now, it)}", style = StarbridgeTheme.type.meta, color = scheme.onSurfaceVariant) }
                    Text(error, style = StarbridgeTheme.type.meta, color = scheme.onSurfaceVariant)
                }
            }
            windows.forEachIndexed { i, w ->
                if (i > 0) HorizontalDivider(color = scheme.outlineVariant, modifier = Modifier.padding(top = Spacing.s4))
                WindowRow(w, now, settings, Modifier.padding(top = if (i > 0) Spacing.s4 else Spacing.s3))
            }
        }
    }
}

@Composable
private fun WindowRow(window: QuotaWindow, now: Instant, settings: QuotaSettings, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val type = StarbridgeTheme.type
    val tone = tone(window, now, settings.absoluteResets)
    val ended = window.ended(now)
    val course = window.course(now)
    val bar = settings.bar(window, now)
    val h24 = LocalClock24.current
    val card = scheme.surfaceContainer
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
        // At least one line of body text, 24 dp at the default font size: the figure's glyphs are
        // taller than the line they sit on. A long window name takes a second line.
        val line = with(LocalDensity.current) { type.body.lineHeight.toDp() }
        Row(Modifier.heightIn(min = line), verticalAlignment = Alignment.CenterVertically) {
            Text(
                window.window,
                style = type.body,
                color = scheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                buildAnnotatedString {
                    append("${if (course == Course.RanOut && settings.showUsed) 100 else bar.percent}")
                    withStyle(SpanStyle(fontSize = type.label.fontSize, fontWeight = type.label.fontWeight)) { append("%") }
                },
                style = type.figure.copy(lineHeight = type.figure.fontSize),
                color = if (ended) scheme.onSurfaceVariant else scheme.onSurface,
                modifier = Modifier.height(line).wrapContentHeight(Alignment.Top, unbounded = true),
            )
        }
        Meter(bar, course, StarbridgeTheme.provider(window.provider), settings.showUsed, card)
        // The pace and the reset time on one line, or two when both don't fit.
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
            Text(tone.word, style = type.metaStrong, color = tone.color, modifier = Modifier.padding(end = Spacing.s2))
            Text(
                window.resetsAt?.let { if (ended) "Reset ${ago(now, it)}" else if (settings.absoluteResets) "Resets ${clockAt(it, now, h24)}" else "Resets in ${span(now, it)}" } ?: "Reset time unknown",
                style = type.meta,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

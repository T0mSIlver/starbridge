package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.openLink
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.since
import dev.starbridge.app.ui.span
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Duration
import java.time.Instant

/** The machine's kind, as its symbol; a machine that predates kinds is a computer. */
fun machineSym(kind: String?) = when (kind) {
    "server" -> Sym.Server
    "desktop" -> Sym.Desktop
    "laptop" -> Sym.Laptop
    "cloud" -> Sym.Cloud
    else -> Sym.Computer
}

/**
 * The one meta row: facts Starbridge knows, never the agent's words. The machine's kind and
 * name, the repo, then [time] at the end: in amber at weight 500 while an agent waits ([clock]),
 * as the time slot is the only place that state shows (#191).
 */
@Composable
fun MetaRow(source: Source, time: String, modifier: Modifier = Modifier, clock: Boolean = false, words: List<String> = emptyList()) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    val style = StarbridgeTheme.type.machine
    Row(modifier.heightIn(min = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        Symbol(machineSym(source.machineKind), size = 17.dp, tint = color)
        Spacer(Modifier.width(6.dp))
        Text(
            highlight(listOf(source.machine, source.project).filter { it.isNotBlank() }.joinToString(" · "), words, hitStyle()),
            style = style,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (time.isNotEmpty()) {
            Text(
                time,
                style = if (clock) style.copy(fontWeight = FontWeight(500)) else style,
                color = if (clock) StarbridgeTheme.colors.accent else color,
                maxLines = 1,
                modifier = Modifier.padding(start = Spacing.s3),
            )
        }
    }
}

/** "1:12" under an hour, then "1 h 05 min": how long something has waited, by the second. */
fun waited(since: Instant, now: Instant): String {
    val s = Duration.between(since, now).seconds.coerceAtLeast(0)
    return if (s < 3600) "${s / 60}:${"%02d".format(s % 60)}" else span(since, now)
}

/** The time slot: how long the agent has waited, from [waitingSince], else the item's age. */
fun timeSlot(waitingSince: Instant?, createdAt: Instant, now: Instant) = if (waitingSince != null) waited(waitingSince, now) else since(createdAt, now)

/**
 * What a screen reader hears first on an item that blocks an agent, as no text on it says so:
 * "Waiting for you, 2 minutes".
 */
fun waitingLabel(since: Instant, now: Instant): String {
    val m = Duration.between(since, now).toMinutes().coerceAtLeast(0)
    return "Waiting for you, " + when (m) {
        0L -> "under a minute"
        1L -> "1 minute"
        else -> "$m minutes"
    }
}

/** "orchestrate-m…r-before-cli": the middle gives way, so both ends stay readable. */
fun middle(text: String, max: Int): String {
    if (text.length <= max) return text
    val head = max / 2
    return text.take(head) + "…" + text.takeLast(max - 1 - head)
}

private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F-]+$")

/** The session's title, else its id: a UUID's first 8 characters. */
fun sessionName(s: Source) = when {
    !s.title.isNullOrBlank() -> s.title
    UUID_RE.matches(s.session) -> s.session.take(8)
    else -> s.session
}

/**
 * The agent's app, by the machine's word for it or, when it sends none, by the session's link. An agent this app does not know gets no "Open in".
 */
fun agentName(agent: String?, source: Source) = when {
    agent == "codex" -> "Codex"
    agent == "claude-code" -> "Claude"
    agent == null && source.links.any { it.url.startsWith("https://claude.ai/") } -> "Claude"
    else -> null
}

/**
 * The end of every detail: the session's name, middle-truncated, and "Open in Claude" or
 * "Open in Codex" when the session has a link this phone can open.
 */
@Composable
fun SessionLine(source: Source, agent: String?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val name = sessionName(source)
    val link = source.links.firstOrNull { it.kind != "desktop" }
    val app = agentName(agent, source)
    if (name.isBlank() && link == null) return
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s3)) {
        // A title is words; only a bare session id is set as code (#563).
        val nameStyle = if (source.title.isNullOrBlank()) SpanStyle(color = scheme.onSurface, fontFamily = StarbridgeTheme.type.code.fontFamily, fontSize = StarbridgeTheme.type.meta.fontSize)
        else SpanStyle(color = scheme.onSurface)
        val line = { max: Int ->
            buildAnnotatedString {
                if (name.isNotBlank()) {
                    append("Session ")
                    withStyle(nameStyle) { append(middle(name, max)) }
                }
            }
        }
        val measurer = rememberTextMeasurer()
        val style = StarbridgeTheme.type.small
        BoxWithConstraints(Modifier.weight(1f)) {
            // Cut in the middle only when the line runs out of room, as on the web (#172).
            val room = constraints.maxWidth
            val max = (name.length downTo 8).firstOrNull { measurer.measure(line(it), style, maxLines = 1).size.width <= room } ?: 8
            Text(line(max), style = style, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (link != null && app != null) {
            Text(
                "Open in $app",
                style = StarbridgeTheme.type.small.copy(textDecoration = TextDecoration.Underline),
                color = scheme.onSurface,
                maxLines = 1,
                modifier = Modifier.clickable(onClickLabel = "Open the session") { openLink(context, link.url) }.padding(vertical = Spacing.s3),
            )
        }
    }
}

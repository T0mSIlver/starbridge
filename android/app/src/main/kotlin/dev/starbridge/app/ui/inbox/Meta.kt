package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.openLink
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
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
 * name, the repo, then [time] at the end.
 */
@Composable
fun MetaRow(source: Source, time: String, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    val style = StarbridgeTheme.type.machine
    Row(modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically) {
        Symbol(machineSym(source.machineKind), size = 17.dp, tint = color)
        Spacer(Modifier.width(6.dp))
        Text(
            listOf(source.machine, source.project).filter { it.isNotBlank() }.joinToString(" · "),
            style = style,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (time.isNotEmpty()) Text(time, style = style, color = color, maxLines = 1, modifier = Modifier.padding(start = Spacing.s3))
    }
}

/** "1:12" under an hour, then "1 h 05 min": how long something has waited, by the second. */
fun waited(since: Instant, now: Instant): String {
    val s = Duration.between(since, now).seconds.coerceAtLeast(0)
    return if (s < 3600) "${s / 60}:${"%02d".format(s % 60)}" else span(since, now)
}

/**
 * "Waiting for you 1:12", in amber: what holds an agent up. The icon is placed in the text, so it
 * sits on the text's centre line at any font scale.
 */
@Composable
fun WaitTag(since: Instant?, now: Instant, modifier: Modifier = Modifier) {
    val accent = StarbridgeTheme.colors.accent
    val style = StarbridgeTheme.type.label
    val icon = with(LocalDensity.current) { 16.dp.toSp() }
    Text(
        buildAnnotatedString {
            appendInlineContent(ICON, " ")
            append(" Waiting for you")
            since?.let { append(" ${waited(it, now)}") }
        },
        inlineContent = mapOf(ICON to InlineTextContent(Placeholder(icon, icon, PlaceholderVerticalAlign.TextCenter)) { Symbol(Sym.Waiting, size = 16.dp, tint = accent) }),
        style = style,
        color = accent,
        maxLines = 1,
        modifier = modifier,
    )
}

private const val ICON = "icon"

/**
 * A question's state, shown only once its agent waits on it: a question with no state line is
 * one the agent works around (#166).
 */
@Composable
fun StateLine(decision: Decision, now: Instant, modifier: Modifier = Modifier) {
    if (decision.waiting) WaitTag(decision.waitingSince, now, modifier)
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

/** The agent's app, by the machine's word for it or, before that, by the session's link. */
fun agentName(agent: String?, source: Source) = when {
    agent == "codex" -> "Codex"
    agent == "claude-code" -> "Claude"
    source.links.any { it.url.startsWith("https://claude.ai/") } -> "Claude"
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
        Text(
            buildAnnotatedString {
                if (name.isNotBlank()) {
                    append("Session ")
                    withStyle(SpanStyle(color = scheme.onSurface, fontFamily = StarbridgeTheme.type.code.fontFamily, fontSize = StarbridgeTheme.type.meta.fontSize)) { append(middle(name, 26)) }
                }
            },
            style = StarbridgeTheme.type.small,
            color = scheme.onSurfaceVariant,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
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

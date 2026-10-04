package dev.starbridge.app.ui.inbox

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class InboxViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val decisions = store.decisions
    fun answer(id: String, choice: String?, text: String?) = store.answer(id, choice, text)
    fun refresh() = store.refresh()
}

/** What a decision card can do: answer with an option or text, or open the full decision. */
class DecisionActions(val answer: (id: String, choice: String?, text: String?) -> Unit, val open: (String) -> Unit)

/** Open decisions first, newest on top; answered ones below. */
@Composable
fun InboxScreen(decisions: List<Decision>, now: Instant, actions: DecisionActions, modifier: Modifier = Modifier, selected: String? = null) {
    val open = decisions.filter { it.open }.sortedByDescending { it.createdAt }
    val answered = decisions.filterNot { it.open }.sortedByDescending { it.answeredAt }
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        item { Title("Inbox") }
        item {
            Label(if (open.isEmpty()) "Nothing needs you" else "${open.size} need you", color = if (open.isEmpty()) StarbridgeTheme.colors.fg3 else StarbridgeTheme.colors.accent)
        }
        items(open, key = { it.id }) {
            OpenDecision(it, now, actions, selected = it.id == selected, modifier = Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null))
        }
        if (answered.isNotEmpty()) {
            item(key = "answered") { Label("Answered", Modifier.padding(top = Spacing.s4)) }
            items(answered, key = { it.id }) {
                AnsweredDecision(it, now, onOpen = { actions.open(it.id) }, modifier = Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null))
            }
        }
    }
}

private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F-]+$")

/** The session's title, else its id (a UUID's first 8 characters); [full] shows the whole id. */
private fun sessionName(s: Source, full: Boolean) = when {
    full -> s.session
    !s.title.isNullOrBlank() -> s.title
    UUID_RE.matches(s.session) -> s.session.take(8)
    else -> s.session
}

/** Long-pressing it shows the session's full id, when [revealable]. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Source(decision: Decision, now: Instant, revealable: Boolean = false) {
    val s = decision.source
    var full by rememberSaveable { mutableStateOf(false) }
    Text(
        listOf(s.machine, s.project, sessionName(s, full), ago(now, decision.createdAt)).filter { it.isNotBlank() }.joinToString(" · "),
        style = StarbridgeTheme.type.machine,
        color = StarbridgeTheme.colors.fg3,
        modifier = if (revealable && s.session.isNotBlank()) {
            Modifier.combinedClickable(onClickLabel = null, onLongClickLabel = "Show the session id", onLongClick = { full = !full }, onClick = {})
        } else {
            Modifier
        },
    )
}

/**
 * Opens the session that asked: claude.ai/code links go to the Claude app when it is installed,
 * else the browser. Desktop links are for a computer and stay hidden here.
 */
@Composable
private fun SessionLinks(source: Source) {
    val context = LocalContext.current
    val links = source.links.filter { it.kind != "desktop" }
    links.forEach { link ->
        OutlinedButton(
            onClick = {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.url))) }
            },
            modifier = Modifier.heightIn(min = Sizes.tap),
        ) {
            Text("Open session", style = StarbridgeTheme.type.action)
        }
    }
}

private fun fallback(d: Decision) = "If nobody answers: ${d.default}" + (d.defaultAt?.let { ", at ${clock(it)}" } ?: "")

@Composable
private fun OpenDecision(decision: Decision, now: Instant, actions: DecisionActions, selected: Boolean, modifier: Modifier = Modifier) {
    val colors = StarbridgeTheme.colors
    Panel(modifier.fillMaxWidth(), border = if (selected) colors.accent else colors.lineStrong) {
        Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Read the whole decision") { actions.open(decision.id) }) {
            Source(decision, now)
            Spacer(Modifier.padding(top = Spacing.s2))
            Text(decision.question, style = StarbridgeTheme.type.question, color = colors.fg)
            Spacer(Modifier.padding(top = Spacing.s1))
            Text(plain(decision.context), style = StarbridgeTheme.type.body, color = colors.fg2, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.padding(top = Spacing.s4))
        Answer(decision, actions.answer)
        Spacer(Modifier.padding(top = Spacing.s3))
        Text(fallback(decision), style = StarbridgeTheme.type.small, color = colors.fg3)
    }
}

/** The options as a connected button group, or a reply field when there are none. */
@Composable
private fun Answer(decision: Decision, answer: (String, String?, String?) -> Unit) {
    if (decision.options.isEmpty()) FreeText { answer(decision.id, null, it) }
    else Options(decision) { answer(decision.id, it, null) }
}

/**
 * A vertical connected button group (Material 3 Expressive): the options touch, outer corners
 * round, inner ones tight. The recommended option leads, filled in the beacon's colour, since
 * it is what needs the owner.
 */
@Composable
fun Options(decision: Decision, onAnswer: (String) -> Unit) {
    val colors = StarbridgeTheme.colors
    val ordered = decision.options.sortedByDescending { it == decision.recommended }
    val outer = Sizes.tap / 2
    val inner = 4.dp
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ordered.forEachIndexed { i, option ->
            val shape = RoundedCornerShape(
                topStart = if (i == 0) outer else inner,
                topEnd = if (i == 0) outer else inner,
                bottomStart = if (i == ordered.lastIndex) outer else inner,
                bottomEnd = if (i == ordered.lastIndex) outer else inner,
            )
            val recommended = option == decision.recommended
            Button(
                onClick = { onAnswer(option) },
                modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
                shape = shape,
                colors = if (recommended) {
                    ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent)
                } else {
                    ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer)
                },
                contentPadding = PaddingValues(horizontal = Spacing.s5, vertical = Spacing.s3),
            ) {
                Text(option, style = StarbridgeTheme.type.action, modifier = Modifier.weight(1f))
                if (recommended) Text("Recommended", style = StarbridgeTheme.type.label)
            }
        }
    }
}

@Composable
private fun FreeText(onAnswer: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = { if (text.isNotBlank()) onAnswer(text.trim()) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it.take(4000) },
            placeholder = { Text("Your answer") },
            textStyle = StarbridgeTheme.type.body,
            shape = RoundedCornerShape(Radius.md),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Spacing.s2))
        FilledIconButton(onClick = send, enabled = text.isNotBlank(), modifier = Modifier.size(Sizes.tap)) {
            Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send")
        }
    }
}

@Composable
private fun Outcome(decision: Decision, now: Instant) {
    val colors = StarbridgeTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        // The check springs in when the answer lands (the theme's expressive motion scheme).
        AnimatedVisibility(visible = true, enter = scaleIn(MaterialTheme.motionScheme.fastSpatialSpec())) {
            Icon(Icons.Rounded.Check, contentDescription = null, tint = colors.ok, modifier = Modifier.size(Spacing.s4))
        }
        Spacer(Modifier.width(Spacing.s1))
        val at = decision.answeredAt?.let { " · ${ago(now, it)}" }.orEmpty()
        Text((decision.answer ?: "Answered on another device") + at, style = StarbridgeTheme.type.small, color = colors.fg)
    }
}

@Composable
private fun AnsweredDecision(decision: Decision, now: Instant, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val colors = StarbridgeTheme.colors
    Panel(modifier.fillMaxWidth().clickable(onClick = onOpen)) {
        Source(decision, now)
        Spacer(Modifier.padding(top = Spacing.s1))
        Text(decision.question, style = StarbridgeTheme.type.body, color = colors.fg2)
        Spacer(Modifier.padding(top = Spacing.s2))
        Outcome(decision, now)
    }
}

/** The whole decision: its context in full, code in mono, and the answer. */
@Composable
fun DecisionScreen(decision: Decision?, now: Instant, onAnswer: (String, String?, String?) -> Unit, modifier: Modifier = Modifier) {
    val colors = StarbridgeTheme.colors
    if (decision == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Pick a decision to read it in full.", style = StarbridgeTheme.type.body, color = colors.fg3)
        }
        return
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
        Spacer(Modifier.padding(top = Spacing.s2))
        Source(decision, now, revealable = true)
        Text(decision.question, style = StarbridgeTheme.type.heading, color = colors.fg)
        Context(decision.context)
        Spacer(Modifier.padding(top = Spacing.s2))
        if (decision.open) Answer(decision, onAnswer) else Outcome(decision, now)
        Text(fallback(decision), style = StarbridgeTheme.type.small, color = colors.fg3)
        SessionLinks(decision.source)
    }
}

/** Markdown's code, fenced or inline, in mono; everything else in the sans. */
@Composable
private fun Context(text: String) {
    val colors = StarbridgeTheme.colors
    text.split("```").forEachIndexed { i, part ->
        if (i % 2 == 1) {
            val code = part.substringAfter('\n', part).trimEnd()
            Surface(shape = RoundedCornerShape(Radius.sm), color = colors.surface2, modifier = Modifier.fillMaxWidth()) {
                Text(code, style = StarbridgeTheme.type.code, color = colors.fg, modifier = Modifier.padding(Spacing.s3))
            }
        } else if (part.isNotBlank()) {
            Text(inline(part.trim(), colors.surface2), style = StarbridgeTheme.type.body, color = colors.fg2)
        }
    }
}

private fun inline(text: String, background: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    text.split('`').forEachIndexed { i, part ->
        if (i % 2 == 1) withStyle(SpanStyle(fontFamily = StarbridgeTheme.type.code.fontFamily, background = background)) { append(part) }
        else append(part)
    }
}

/** The card's preview: code markers dropped. */
private fun plain(text: String) = text.replace("```", "").replace("`", "")

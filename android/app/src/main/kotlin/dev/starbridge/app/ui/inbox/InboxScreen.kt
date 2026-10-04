package dev.starbridge.app.ui.inbox

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.ButtonGroup
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedToggleButton
import androidx.compose.material3.OutlinedToggleButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.ToggleButton
import androidx.compose.material3.ToggleButtonDefaults
import androidx.compose.material3.ToggleButtonShapes
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.Store
import dev.starbridge.app.data.openLink
import dev.starbridge.app.ui.Beacon
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.Refreshable
import dev.starbridge.app.ui.Screen
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.delay
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

/** Open decisions first, newest on top; answered ones below, one line each. */
@Composable
fun InboxScreen(
    decisions: List<Decision>,
    now: Instant,
    actions: DecisionActions,
    modifier: Modifier = Modifier,
    selected: String? = null,
    refresh: Refresh? = null,
) {
    val open = decisions.filter { it.open }.sortedByDescending { it.createdAt }
    val answered = decisions.filterNot { it.open }.sortedByDescending { it.answeredAt }
    Screen("Inbox", modifier, subtitle = { NeedsYou(open.size) }) { padding ->
        Refreshable(refresh) {
            LazyColumn(
                contentPadding = listPadding(padding),
                verticalArrangement = Arrangement.spacedBy(Spacing.s3),
            ) {
                itemsIndexed(open, key = { _, it -> it.id }) { _, it ->
                    OpenDecision(it, now, actions, selected = it.id == selected, modifier = Modifier.animateItem())
                }
                if (answered.isNotEmpty()) {
                    item(key = "answered") { Label("Answered", Modifier.padding(top = Spacing.s4, start = Spacing.s1).animateItem()) }
                    itemsIndexed(answered, key = { _, it -> it.id }) { i, it ->
                        Column(Modifier.animateItem()) {
                            if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            AnsweredLine(it, now, onOpen = { actions.open(it.id) })
                        }
                    }
                }
            }
        }
    }
}

/** The top app bar's subtitle: how many decisions wait, with the beacon when any do. */
@Composable
private fun NeedsYou(count: Int) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (count > 0) {
            Beacon()
            Spacer(Modifier.width(Spacing.s2))
        }
        Text(if (count == 0) "Nothing needs you" else "$count need you", style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

/**
 * Where a decision comes from and when: machine, project, session. Long-pressing it shows the
 * session's full id, when [revealable].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Source(decision: Decision, now: Instant, revealable: Boolean = false) {
    val s = decision.source
    var full by rememberSaveable { mutableStateOf(false) }
    val reveal = if (revealable && s.session.isNotBlank()) {
        Modifier.combinedClickable(onLongClickLabel = "Show the session id", onLongClick = { full = !full }, onClick = {})
    } else {
        Modifier
    }
    Row(reveal, verticalAlignment = Alignment.CenterVertically) {
        if (decision.open) {
            Beacon()
            Spacer(Modifier.width(Spacing.s2))
        }
        // The session's names give way before the time does.
        Text(
            listOf(s.machine, s.project, sessionName(s, full)).filter { it.isNotBlank() }.joinToString(" · "),
            style = StarbridgeTheme.type.machine,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (full) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Text(" · ${ago(now, decision.createdAt)}", style = StarbridgeTheme.type.machine, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

/**
 * Opens the session that asked: claude.ai/code links go to the Claude app when it is installed,
 * else the browser (openLink). Desktop links are for a computer and stay hidden here.
 */
@Composable
private fun SessionLinks(source: Source) {
    val context = LocalContext.current
    source.links.filter { it.kind != "desktop" }.forEach { link ->
        TextButton(
            onClick = { openLink(context, link.url) },
            modifier = Modifier.heightIn(min = Sizes.tap),
        ) {
            Icon(Icons.AutoMirrored.Rounded.OpenInNew, contentDescription = null, modifier = Modifier.size(Spacing.s5))
            Spacer(Modifier.width(Spacing.s2))
            Text("Open session", style = StarbridgeTheme.type.action)
        }
    }
}

/** "If nobody answers: Waits until tonight, at 22:00", the default in the text colour. */
@Composable
private fun Fallback(decision: Decision) {
    Text(
        buildAnnotatedString {
            append("If nobody answers: ")
            withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurface)) { append(decision.default) }
            decision.defaultAt?.let { append(", at ${clock(it)}") }
        },
        style = StarbridgeTheme.type.small,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun OpenDecision(decision: Decision, now: Instant, actions: DecisionActions, selected: Boolean, modifier: Modifier = Modifier) {
    // On wide screens the card shown in the detail pane steps up a surface.
    Panel(modifier.fillMaxWidth(), color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().clickable(onClickLabel = "Read the whole decision") { actions.open(decision.id) },
            verticalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            Source(decision, now)
            Text(decision.question, style = StarbridgeTheme.type.question, color = MaterialTheme.colorScheme.onSurface)
            if (decision.context.isNotBlank()) {
                Text(plain(decision.context), style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            Images(decision.images, maxHeight = Sizes.media / 2, modifier = Modifier.padding(top = Spacing.s2))
        }
        Links(decision.links, Modifier.padding(top = Spacing.s2))
        Spacer(Modifier.padding(top = Spacing.s4))
        Answer(decision, actions.answer)
        Spacer(Modifier.padding(top = Spacing.s3))
        Fallback(decision)
    }
}

/** The options as a connected button group, or a reply field when there are none. */
@Composable
private fun Answer(decision: Decision, answer: (String, String?, String?) -> Unit) {
    val haptics = LocalHapticFeedback.current
    if (decision.options.isEmpty()) {
        FreeText {
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            answer(decision.id, null, it)
        }
    } else {
        Options(decision) {
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            answer(decision.id, it, null)
        }
    }
}

/**
 * A connected button group (Material 3 Expressive). The recommended option leads, filled in
 * amber, the only filled button; the others are outlined. Side by side when every label fits on
 * one line, each as wide as its label needs; else stacked, since options run up to 100
 * characters. The tapped option takes its checked shape while the answer goes out.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Options(decision: Decision, onAnswer: (String) -> Unit) {
    val ordered = decision.options.sortedByDescending { it == decision.recommended }
    var chosen by remember(decision.id) { mutableStateOf<String?>(null) }
    // A second tap while the answer goes out is dropped. If it fails, the decision stays open
    // and the options take taps again.
    LaunchedEffect(chosen) {
        if (chosen != null) {
            delay(RETRY_AFTER_MS)
            chosen = null
        }
    }
    val pick = { option: String ->
        if (chosen == null) {
            chosen = option
            onAnswer(option)
        }
    }
    val measurer = rememberTextMeasurer()
    val style = StarbridgeTheme.type.action
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val needs = ordered.map { option ->
            with(density) { measurer.measure(option, style, maxLines = 1).size.width.toDp() } + optionPadding * 2
        }
        val gaps = ButtonGroupDefaults.ConnectedSpaceBetween * (ordered.size - 1)
        val fits = needs.fold(gaps) { sum, it -> sum + it } <= maxWidth
        if (fits) {
            ButtonGroup(
                overflowIndicator = {},
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween),
            ) {
                ordered.forEachIndexed { i, option ->
                    customItem(
                        buttonGroupContent = {
                            val shapes = when (i) {
                                0 -> ButtonGroupDefaults.connectedLeadingButtonShapes()
                                ordered.lastIndex -> ButtonGroupDefaults.connectedTrailingButtonShapes()
                                else -> ButtonGroupDefaults.connectedMiddleButtonShapes()
                            }
                            OptionButton(
                                option,
                                recommended = option == decision.recommended,
                                checked = option == chosen,
                                shapes = if (ordered.size == 1) single() else shapes,
                                onClick = { pick(option) },
                                modifier = Modifier.weight(needs[i].value).heightIn(min = Sizes.tap),
                            )
                        },
                        menuContent = { state -> DropdownMenuItem(text = { Text(option) }, onClick = { state.dismiss(); pick(option) }) },
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween)) {
                ordered.forEachIndexed { i, option ->
                    OptionButton(
                        option,
                        recommended = option == decision.recommended,
                        checked = option == chosen,
                        shapes = stacked(i, ordered.size),
                        onClick = { pick(option) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
                    )
                }
            }
        }
    }
}

private const val RETRY_AFTER_MS = 3_000L

/** An option's padding on each side of its label. */
private val optionPadding = Spacing.s4

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun OptionButton(option: String, recommended: Boolean, checked: Boolean, shapes: ToggleButtonShapes, onClick: () -> Unit, modifier: Modifier) {
    val colors = StarbridgeTheme.colors
    val content = PaddingValues(horizontal = optionPadding, vertical = Spacing.s3)
    val semantics = Modifier.semantics {
        role = Role.Button
        if (recommended) stateDescription = "Recommended"
    }
    val label: @Composable () -> Unit = { Text(option, style = StarbridgeTheme.type.action, textAlign = TextAlign.Center) }
    if (recommended) {
        ToggleButton(
            checked = checked,
            onCheckedChange = { onClick() },
            modifier = modifier.then(semantics),
            shapes = shapes,
            colors = ToggleButtonDefaults.colors(
                containerColor = colors.accent,
                contentColor = colors.onAccent,
                checkedContainerColor = colors.accentHi,
                checkedContentColor = colors.onAccent,
            ),
            contentPadding = content,
        ) { label() }
    } else {
        OutlinedToggleButton(
            checked = checked,
            onCheckedChange = { onClick() },
            modifier = modifier.then(semantics),
            shapes = shapes,
            colors = OutlinedToggleButtonDefaults.colors(
                contentColor = MaterialTheme.colorScheme.primary,
                checkedContainerColor = MaterialTheme.colorScheme.primary,
                checkedContentColor = MaterialTheme.colorScheme.onPrimary,
            ),
            contentPadding = content,
        ) { label() }
    }
}

/** A lone option: round ends, as a standalone button. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun single() = ToggleButtonDefaults.shapesFor(Sizes.tap)

/**
 * Stacked options keep the connected group's shapes turned on their side: round ends on the
 * group's outside, `radius.sm` inside, fully round while pressed or checked.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
private fun stacked(index: Int, count: Int): ToggleButtonShapes {
    val round = RoundedCornerShape(Radius.pill)
    val end = Sizes.tap / 2
    val shape: Shape = RoundedCornerShape(
        topStart = if (index == 0) end else Radius.sm,
        topEnd = if (index == 0) end else Radius.sm,
        bottomStart = if (index == count - 1) end else Radius.sm,
        bottomEnd = if (index == count - 1) end else Radius.sm,
    )
    return ToggleButtonShapes(shape = shape, pressedShape = round, checkedShape = round)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FreeText(onAnswer: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = { if (text.isNotBlank()) onAnswer(text.trim()) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextField(
            value = text,
            onValueChange = { text = it.take(4000) },
            placeholder = { Text("Your answer") },
            textStyle = StarbridgeTheme.type.body,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            colors = fieldColors(),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Spacing.s2))
        FilledIconButton(onClick = send, enabled = text.isNotBlank(), modifier = Modifier.size(Sizes.tap)) {
            Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send")
        }
    }
}

/** Who answered: this phone with its answer, or another device. */
private fun answeredBy(decision: Decision) = if (decision.answer != null) "This phone" else "Another device"

/** An answered decision in one line: the answer, the question, which device answered and when. */
@Composable
private fun AnsweredLine(decision: Decision, now: Instant, onOpen: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = Sizes.tap).clickable(onClickLabel = "Read the whole decision", onClick = onOpen).padding(horizontal = Spacing.s1, vertical = Spacing.s3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurface, fontWeight = StarbridgeTheme.type.label.fontWeight)) { append(decision.answer ?: "Answered") }
                append("  ")
                append(decision.question)
            },
            style = StarbridgeTheme.type.small,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Spacing.s3))
        val at = decision.answeredAt?.let { " · ${ago(now, it)}" }.orEmpty()
        Text(answeredBy(decision) + at, style = StarbridgeTheme.type.machine, color = colors.fg3, maxLines = 1)
    }
}

@Composable
private fun Outcome(decision: Decision, now: Instant) {
    val colors = StarbridgeTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        // The check springs in when the answer lands (the theme's expressive motion scheme).
        AnimatedVisibility(visible = true, enter = scaleIn(MaterialTheme.motionScheme.fastSpatialSpec())) {
            Icon(Icons.Rounded.Check, contentDescription = null, tint = colors.ok, modifier = Modifier.size(Spacing.s5))
        }
        Spacer(Modifier.width(Spacing.s2))
        val at = decision.answeredAt?.let { " · ${ago(now, it)}" }.orEmpty()
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurface)) { append(decision.answer ?: "Answered") }
                append(" · ${answeredBy(decision)}$at")
            },
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The whole decision: its context in full, code in mono, and the answer. [onBack] is set when
 * the decision covers the inbox (one pane); beside it, there is nothing to go back to.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DecisionScreen(decision: Decision?, now: Instant, onAnswer: (String, String?, String?) -> Unit, modifier: Modifier = Modifier, onBack: (() -> Unit)? = null) {
    val colors = StarbridgeTheme.colors
    if (decision == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Pick a decision to read it in full.", style = StarbridgeTheme.type.body, color = colors.fg3)
        }
        return
    }
    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0),
        containerColor = MaterialTheme.colorScheme.surface,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back to the inbox") }
                    }
                },
                actions = { SessionLinks(decision.source) },
                windowInsets = WindowInsets(0),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(padding).padding(horizontal = Spacing.s5, vertical = Spacing.s2),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            Column(Modifier.widthIn(max = Sizes.content), verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
                Source(decision, now, revealable = true)
                Text(decision.question, style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface)
                Context(decision.context)
                Images(decision.images, maxHeight = Sizes.media)
                Links(decision.links)
                Spacer(Modifier.padding(top = Spacing.s1))
                if (decision.open) Answer(decision, onAnswer) else Outcome(decision, now)
                Fallback(decision)
            }
        }
    }
}

/** Markdown's code, fenced or inline, in mono; everything else in the sans. */
@Composable
private fun Context(text: String) {
    text.split("```").forEachIndexed { i, part ->
        if (i % 2 == 1) {
            val code = part.substringAfter('\n', part).trimEnd()
            Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
                Text(code, style = StarbridgeTheme.type.code, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(Spacing.s4))
            }
        } else if (part.isNotBlank()) {
            Text(inline(part.trim(), MaterialTheme.colorScheme.surfaceContainerHighest), style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

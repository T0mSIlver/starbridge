package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.layout.widthIn
import dev.starbridge.app.data.PromptScope
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.SheetBody
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.since
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.time.Instant

/** What a prompt can do: allow for a scope, deny with an optional note, open its sheet. */
class PromptActions(
    val answer: (id: String, allow: Boolean, scope: String, message: String?) -> Unit,
    val open: (id: String) -> Unit = {},
)

/** How long the buttons wait after a tap before taking taps again, should the send have failed. */
private const val RETRY_AFTER_MS = 8_000L

/** How long a prompt settled elsewhere stays, saying where, before it leaves. */
const val CLOSING_MS = 3_000L

/** The prompts to show in the feed: waiting ones, and ones that ended a moment ago. */
fun shownPrompts(prompts: List<Prompt>, now: Instant): List<Prompt> = prompts
    .filter { it.waiting(now) || (it.endedAt != null && now.toEpochMilli() - it.endedAt.toEpochMilli() < CLOSING_MS) }
    .sortedByDescending { it.createdAt }

private val pretty = Json { prettyPrint = true }

private fun prettyInput(input: String) = runCatching { pretty.encodeToString(JsonElement.serializer(), Json.parseToJsonElement(input)) }.getOrDefault(input)

/** A prompt's ground: amber, faint, over the page, since it holds an agent up. */
@Composable
fun promptGround(): Color = StarbridgeTheme.colors.accentSoft.compositeOver(MaterialTheme.colorScheme.surface)

/** The exact command, in mono, on [color]. */
@Composable
private fun Command(text: String, style: TextStyle, color: Color, shape: Shape, padding: PaddingValues, maxLines: Int = Int.MAX_VALUE) {
    Text(
        text,
        style = style,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().background(color, shape).padding(padding),
    )
}

/** Sends once, with a confirm tick; a send that failed leaves the prompt waiting, so taps come back. */
@Composable
private fun rememberSend(prompt: Prompt, actions: PromptActions): Pair<Boolean, (Boolean, String, String?) -> Unit> {
    val haptics = LocalHapticFeedback.current
    var sent by remember(prompt.id) { mutableStateOf(false) }
    LaunchedEffect(sent) {
        if (sent) {
            delay(RETRY_AFTER_MS)
            sent = false
        }
    }
    return sent to { allow, scope, message ->
        if (!sent) {
            sent = true
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            actions.answer(prompt.id, allow, scope, message)
        }
    }
}

/** The connected Allow and Deny, Allow the one amber button; [trailing] closes the group. */
@Composable
private fun AllowDeny(height: Dp, enabled: Boolean, ground: Color, onAllow: () -> Unit, onDeny: () -> Unit, trailing: (@Composable () -> Unit)? = null) {
    val colors = StarbridgeTheme.colors
    val end = height / 2
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Button(
            onClick = onAllow,
            enabled = enabled,
            shape = RoundedCornerShape(topStart = end, bottomStart = end, topEnd = 8.dp, bottomEnd = 8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent, disabledContainerColor = colors.accent, disabledContentColor = colors.onAccent),
            modifier = Modifier.weight(1f).height(height),
        ) { Text("Allow", style = if (height > 48.dp) StarbridgeTheme.type.action else StarbridgeTheme.type.label) }
        val last = trailing == null
        Button(
            onClick = onDeny,
            enabled = enabled,
            shape = RoundedCornerShape(topStart = 8.dp, bottomStart = 8.dp, topEnd = if (last) end else 8.dp, bottomEnd = if (last) end else 8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = ground, contentColor = MaterialTheme.colorScheme.onSurface),
            modifier = Modifier.weight(1f).height(height),
        ) { Text("Deny", style = if (height > 48.dp) StarbridgeTheme.type.action else StarbridgeTheme.type.label) }
        trailing?.invoke()
    }
}

/**
 * A waiting permission prompt in the feed, filled as everything that blocks an agent is (#191):
 * amber's faint ground, the clock in the time slot, the terminal symbol and the tool, the exact
 * command, then Allow, Deny and the wider grants behind ⋮.
 */
@Composable
fun PromptCard(prompt: Prompt, now: Instant, actions: PromptActions, shape: Shape, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (sent, send) = rememberSend(prompt, actions)
    var menu by remember { mutableStateOf(false) }
    Surface(
        modifier.fillMaxWidth().clickable(onClickLabel = "Open the prompt") { actions.open(prompt.id) }.semantics { stateDescription = waitingLabel(prompt.createdAt, now) },
        shape = shape,
        color = promptGround(),
    ) {
        Column(Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            MetaRow(prompt.source, waited(prompt.createdAt, now), clock = true)
            ToolLine(prompt, StarbridgeTheme.type.action.copy(lineHeight = 22.sp), 20.dp)
            Command(prompt.summary, StarbridgeTheme.type.code.copy(fontSize = 15.sp, lineHeight = 22.sp), scheme.surfaceContainer, RoundedCornerShape(12.dp), PaddingValues(horizontal = 14.dp, vertical = Spacing.s3), maxLines = 3)
            Box(Modifier.padding(top = Spacing.s1)) {
                AllowDeny(40.dp, !sent, scheme.surfaceContainer, onAllow = { send(true, "once", null) }, onDeny = { send(false, "once", null) }) {
                    Button(
                        onClick = { menu = true },
                        shape = RoundedCornerShape(topStart = 8.dp, bottomStart = 8.dp, topEnd = 20.dp, bottomEnd = 20.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = scheme.surfaceContainer, contentColor = scheme.onSurface),
                        contentPadding = PaddingValues(0.dp),
                        modifier = Modifier.width(48.dp).height(40.dp),
                    ) { Symbol(Sym.More, size = 20.dp, contentDescription = "More answers") }
                }
                Box(Modifier.align(Alignment.TopEnd)) {
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        // Each wider allow shows the exact rule it adds before it is chosen (PROTOCOL.md).
                        prompt.scopes.forEach { scope ->
                            DropdownMenuItem(text = { ScopeText(scope) }, onClick = { menu = false; send(true, scope.scope, null) }, modifier = Modifier.widthIn(max = 320.dp))
                        }
                        DropdownMenuItem(text = { Text("Deny with a note") }, onClick = { menu = false; actions.open(prompt.id) })
                    }
                }
            }
        }
    }
}

/** A wider allow: its label, and under it the exact rule it adds, in mono and in full. */
@Composable
private fun ScopeText(scope: PromptScope) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(scope.label, style = StarbridgeTheme.type.label, color = MaterialTheme.colorScheme.onSurface)
        Text(scope.rule, style = StarbridgeTheme.type.code.copy(fontSize = 13.sp, lineHeight = 18.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The terminal symbol, amber while the prompt waits, and the tool; once ended, how it ended. */
@Composable
private fun ToolLine(prompt: Prompt, style: TextStyle, icon: Dp, waiting: Boolean = true) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Symbol(Sym.Terminal, size = icon, tint = if (waiting) StarbridgeTheme.colors.accent else MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(Spacing.s2))
        Text(prompt.tool, style = style, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, modifier = Modifier.weight(1f))
        if (!waiting) Text(prompt.ended.orEmpty(), style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A prompt that ended elsewhere, for a moment: its command and where it was settled. */
@Composable
fun ClosedPrompt(prompt: Prompt, shape: Shape, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth(), shape = shape, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s1)) {
            Text(prompt.summary, style = StarbridgeTheme.type.code, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(prompt.ended.orEmpty(), style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * A prompt's sheet, its head filled while it waits (#191): the command in full, what the agent says it does, Allow and Deny, and the
 * wider grants with the exact rule each adds. Deny takes an optional note to the agent.
 */
@Composable
fun PromptSheet(prompt: Prompt, now: Instant, actions: PromptActions) {
    val scheme = MaterialTheme.colorScheme
    val (sent, send) = rememberSend(prompt, actions)
    var denying by rememberSaveable(prompt.id) { mutableStateOf(false) }
    var note by rememberSaveable(prompt.id) { mutableStateOf("") }
    var input by rememberSaveable(prompt.id) { mutableStateOf(false) }
    val waiting = prompt.waiting(now)
    SheetBody(
        prompt.source,
        if (waiting) waited(prompt.createdAt, now) else since(prompt.createdAt, now),
        prompt.agent,
        blocked = if (waiting) waitingLabel(prompt.createdAt, now) else null,
        head = { ToolLine(prompt, StarbridgeTheme.type.question, 20.dp, waiting) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Command(prompt.summary, StarbridgeTheme.type.code.copy(fontSize = 17.sp, lineHeight = 26.sp), scheme.surfaceContainerHighest, RoundedCornerShape(Spacing.s4), PaddingValues(horizontal = 18.dp, vertical = Spacing.s4))
            prompt.description?.let { Text(it, style = StarbridgeTheme.type.reading.copy(lineHeight = 22.sp), color = scheme.onSurfaceVariant) }
            if (input) {
                Text(
                    prettyInput(prompt.input),
                    style = StarbridgeTheme.type.code,
                    color = scheme.onSurface,
                    modifier = Modifier.fillMaxWidth().background(scheme.surfaceContainerHighest, RoundedCornerShape(Spacing.s4)).horizontalScroll(rememberScrollState()).padding(Spacing.s4),
                )
            }
            if (waiting) {
                AllowDeny(56.dp, !sent, scheme.surfaceContainerHighest, onAllow = { send(true, "once", null) }, onDeny = { if (denying) send(false, "once", note.ifBlank { null }) else denying = true })
                if (denying) {
                    TextField(
                        value = note,
                        onValueChange = { note = it.take(500) },
                        placeholder = { Text("A note to the agent") },
                        colors = fieldColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else if (prompt.scopes.isNotEmpty()) {
                    // Stacked, each with the exact rule it adds, in full (PROTOCOL.md).
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                        prompt.scopes.forEach { scope ->
                            OutlinedButton(
                                onClick = { send(true, scope.scope, null) },
                                enabled = !sent,
                                shape = RoundedCornerShape(Spacing.s4),
                                border = ButtonDefaults.outlinedButtonBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(scheme.outlineVariant)),
                                contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s3),
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) { Box(Modifier.fillMaxWidth()) { ScopeText(scope) } }
                        }
                    }
                }
            }
            Text(
                if (input) "Hide the full input" else "Show the full input",
                style = StarbridgeTheme.type.small,
                color = scheme.onSurfaceVariant,
                modifier = Modifier.clickable { input = !input }.padding(vertical = Spacing.s1),
            )
        }
    }
}

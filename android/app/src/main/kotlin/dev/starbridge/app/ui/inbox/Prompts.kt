package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.ui.Beacon
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Screen
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement
import java.time.Instant

/** What a prompt card can do: allow for a scope, deny with a note, open the week's log. */
class PromptActions(
    val answer: (id: String, allow: Boolean, scope: String, message: String?) -> Unit,
    val openLog: () -> Unit,
)

/** How long the buttons wait after a tap before taking taps again, should the send have failed. */
private const val RETRY_AFTER_MS = 8_000L

/** How long a prompt settled elsewhere stays, saying where, before it leaves. */
const val CLOSING_MS = 3_000L

/** The prompts to show above the inbox: waiting ones, and ones that ended a moment ago. */
fun shownPrompts(prompts: List<Prompt>, now: Instant): List<Prompt> = prompts
    .filter { it.waiting(now) || (it.endedAt != null && now.toEpochMilli() - it.endedAt.toEpochMilli() < CLOSING_MS) }
    .sortedByDescending { it.createdAt }

private val pretty = Json { prettyPrint = true }

private fun prettyInput(input: String) = runCatching { pretty.encodeToString(JsonElement.serializer(), Json.parseToJsonElement(input)) }.getOrDefault(input)

/** The command or path in an inset, in the code face. */
@Composable
private fun Code(text: String, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) {
    Text(
        text,
        style = StarbridgeTheme.type.code,
        color = StarbridgeTheme.colors.fg,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .fillMaxWidth()
            .background(StarbridgeTheme.colors.surface2, RoundedCornerShape(Radius.lg))
            .padding(horizontal = Spacing.s4, vertical = Spacing.s3),
    )
}

@Composable
fun PromptsHeader(onLog: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Beacon()
        Spacer(Modifier.width(Spacing.s2))
        Label("Prompts", Modifier.weight(1f))
        TextButton(onClick = onLog, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Last 7 days", style = StarbridgeTheme.type.small, color = StarbridgeTheme.colors.fg2)
        }
    }
}

/** A prompt that ended elsewhere, for a moment: its command and where it was settled. */
@Composable
fun ClosedPrompt(prompt: Prompt, modifier: Modifier = Modifier) {
    Panel(modifier.fillMaxWidth()) {
        Text(prompt.summary, style = StarbridgeTheme.type.code, color = StarbridgeTheme.colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(prompt.ended.orEmpty(), style = StarbridgeTheme.type.small, color = StarbridgeTheme.colors.fg2)
    }
}

/**
 * A waiting prompt: who asks, the command, and the answers. Allow once is the one filled amber
 * button; a wider allow shows the exact rule it adds; Deny opens a note to the agent.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PromptCard(prompt: Prompt, now: Instant, actions: PromptActions, modifier: Modifier = Modifier) {
    val colors = StarbridgeTheme.colors
    val haptics = LocalHapticFeedback.current
    var showInput by rememberSaveable(prompt.id) { mutableStateOf(false) }
    var denying by rememberSaveable(prompt.id) { mutableStateOf(false) }
    var note by rememberSaveable(prompt.id) { mutableStateOf("") }
    var sent by remember(prompt.id) { mutableStateOf(false) }
    // A send that failed leaves the prompt waiting: its buttons take taps again.
    LaunchedEffect(sent) {
        if (sent) {
            delay(RETRY_AFTER_MS)
            sent = false
        }
    }
    val send = { allow: Boolean, scope: String, message: String? ->
        if (!sent) {
            sent = true
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            actions.answer(prompt.id, allow, scope, message)
        }
    }
    val s = prompt.source
    Panel(modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(prompt.tool, style = StarbridgeTheme.type.label, color = colors.fg)
                Spacer(Modifier.width(Spacing.s2))
                Text(
                    listOf(s.machine, s.project, s.title ?: s.session.take(8)).filter { it.isNotBlank() }.joinToString(" · "),
                    style = StarbridgeTheme.type.machine,
                    color = colors.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(" · ${ago(now, prompt.createdAt)}", style = StarbridgeTheme.type.machine, color = colors.fg2, maxLines = 1)
            }
            Code(prompt.summary)
            prompt.description?.let { Text(it, style = StarbridgeTheme.type.body, color = colors.fg2) }
            Text(
                if (showInput) "Hide the full input" else "Show the full input",
                style = StarbridgeTheme.type.small,
                color = colors.fg2,
                modifier = Modifier.heightIn(min = Sizes.tap).clickable { showInput = !showInput }.padding(vertical = Spacing.s3),
            )
            if (showInput) {
                Text(
                    prettyInput(prompt.input),
                    style = StarbridgeTheme.type.code,
                    color = colors.fg,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.surface2, RoundedCornerShape(Radius.lg))
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = Spacing.s4, vertical = Spacing.s3),
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s2), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                Button(
                    onClick = { send(true, "once", null) },
                    enabled = !sent,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
                    modifier = Modifier.heightIn(min = Sizes.tap),
                ) { Text("Allow once", style = StarbridgeTheme.type.action) }
                prompt.scopes.forEach { scope ->
                    OutlinedButton(onClick = { send(true, scope.scope, null) }, enabled = !sent, modifier = Modifier.heightIn(min = Sizes.tap)) {
                        Text(scope.label, style = StarbridgeTheme.type.action, color = colors.fg)
                    }
                }
                OutlinedButton(onClick = { denying = !denying }, enabled = !sent, modifier = Modifier.heightIn(min = Sizes.tap)) {
                    Text("Deny", style = StarbridgeTheme.type.action, color = colors.bad)
                }
            }
            prompt.scopes.find { it.scope == "project" }?.let {
                Text(
                    "Always adds ${it.rule} to this project's .claude/settings.local.json.",
                    style = StarbridgeTheme.type.small,
                    color = colors.fg3,
                )
            }
            if (denying) {
                TextField(
                    value = note,
                    onValueChange = { note = it.take(500) },
                    label = { Text("Tell the agent what to do instead (optional)") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(onClick = { send(false, "once", note) }, enabled = !sent, modifier = Modifier.heightIn(min = Sizes.tap)) {
                    Text("Send deny", style = StarbridgeTheme.type.action, color = colors.bad)
                }
            }
        }
    }
}

/** The last 7 days of prompts and who settled them where. */
@Composable
fun PromptLogScreen(prompts: List<Prompt>, now: Instant, modifier: Modifier = Modifier) {
    val rows = prompts.sortedByDescending { it.createdAt }
    Screen("Prompts", modifier) { padding ->
        if (rows.isEmpty()) {
            Text(
                "No permission prompts in the last 7 days.",
                style = StarbridgeTheme.type.body,
                color = StarbridgeTheme.colors.fg2,
                modifier = Modifier.padding(padding).padding(Spacing.s6),
            )
            return@Screen
        }
        LazyColumn(contentPadding = listPadding(padding)) {
            itemsIndexed(rows, key = { _, it -> it.id }) { i, p ->
                Column(Modifier.padding(vertical = Spacing.s1)) {
                    if (i > 0) HorizontalDivider(color = StarbridgeTheme.colors.line)
                    Column(Modifier.padding(vertical = Spacing.s3, horizontal = Spacing.s1), verticalArrangement = Arrangement.spacedBy(Spacing.s1)) {
                        Text(p.summary, style = StarbridgeTheme.type.code, color = StarbridgeTheme.colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${p.tool} · ${p.source.machine} · ${p.source.project} · ${ago(now, p.createdAt)}",
                            style = StarbridgeTheme.type.small,
                            color = StarbridgeTheme.colors.fg3,
                        )
                        Text(
                            p.ended ?: if (p.waiting(now)) "Waiting" else "Expired",
                            style = StarbridgeTheme.type.small,
                            color = StarbridgeTheme.colors.fg2,
                        )
                    }
                }
            }
        }
    }
}

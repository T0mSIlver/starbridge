package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class InboxViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val decisions = store.decisions
    fun answer(id: String, answer: String) = store.answer(id, answer)
}

/** Open decisions first, newest on top; answered ones below. */
@Composable
fun InboxScreen(decisions: List<Decision>, now: Instant, onAnswer: (String, String) -> Unit, modifier: Modifier = Modifier) {
    val open = decisions.filter { it.answer == null }.sortedByDescending { it.askedAt }
    val answered = decisions.filter { it.answer != null }.sortedByDescending { it.answeredAt }
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        item { Title("Inbox") }
        item {
            Label(if (open.isEmpty()) "Nothing needs you" else "${open.size} need you", color = if (open.isEmpty()) StarbridgeTheme.colors.fg3 else StarbridgeTheme.colors.accent)
        }
        items(open, key = { it.id }) { OpenDecision(it, now, onAnswer = { answer -> onAnswer(it.id, answer) }) }
        if (answered.isNotEmpty()) {
            item { Label("Answered", Modifier.padding(top = Spacing.s4)) }
            items(answered, key = { it.id }) { AnsweredDecision(it, now) }
        }
    }
}

@Composable
private fun Source(decision: Decision, now: Instant) {
    val s = decision.source
    Text(
        "${s.machine} · ${s.project} · ${s.session} · ${ago(now, decision.askedAt)}",
        style = StarbridgeTheme.type.machine,
        color = StarbridgeTheme.colors.fg3,
    )
}

@Composable
private fun OpenDecision(decision: Decision, now: Instant, onAnswer: (String) -> Unit) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth(), border = colors.lineStrong) {
        Source(decision, now)
        Spacer(Modifier.padding(top = Spacing.s2))
        Text(decision.question, style = StarbridgeTheme.type.question, color = colors.fg)
        Spacer(Modifier.padding(top = Spacing.s1))
        Text(decision.context, style = StarbridgeTheme.type.body, color = colors.fg2)
        Spacer(Modifier.padding(top = Spacing.s4))
        if (decision.options.isEmpty()) FreeText(onAnswer) else Options(decision, onAnswer)
        Spacer(Modifier.padding(top = Spacing.s3))
        Text("If nobody answers: ${decision.default}", style = StarbridgeTheme.type.small, color = colors.fg3)
    }
}

/** The recommended option first, filled in the beacon's colour; the rest outlined. */
@Composable
private fun Options(decision: Decision, onAnswer: (String) -> Unit) {
    val colors = StarbridgeTheme.colors
    val ordered = decision.options.sortedByDescending { it == decision.recommended }
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        for (option in ordered) {
            val shape = RoundedCornerShape(Radius.pill)
            val fill = Modifier.fillMaxWidth().heightIn(min = Sizes.tap)
            if (option == decision.recommended) {
                Button(onClick = { onAnswer(option) }, modifier = fill, shape = shape) {
                    Text(option, style = StarbridgeTheme.type.action)
                    Spacer(Modifier.weight(1f))
                    Text("RECOMMENDED", style = StarbridgeTheme.type.label)
                }
            } else {
                OutlinedButton(
                    onClick = { onAnswer(option) },
                    modifier = fill,
                    shape = shape,
                    border = BorderStroke(1.dp, colors.lineStrong),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.fg),
                ) {
                    Text(option, style = StarbridgeTheme.type.action)
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun FreeText(onAnswer: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("Your answer") },
            textStyle = StarbridgeTheme.type.body,
            shape = RoundedCornerShape(Radius.md),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Spacing.s2))
        FilledIconButton(onClick = { onAnswer(text.trim()) }, enabled = text.isNotBlank(), modifier = Modifier.size(Sizes.tap)) {
            Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send")
        }
    }
}

@Composable
private fun AnsweredDecision(decision: Decision, now: Instant) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth()) {
        Source(decision, now)
        Spacer(Modifier.padding(top = Spacing.s1))
        Text(decision.question, style = StarbridgeTheme.type.body, color = colors.fg2)
        Spacer(Modifier.padding(top = Spacing.s2))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Check, contentDescription = null, tint = colors.ok, modifier = Modifier.size(Spacing.s4))
            Spacer(Modifier.width(Spacing.s1))
            val at = decision.answeredAt?.let { " · ${ago(now, it)}" }.orEmpty()
            Text("${decision.answer}$at", style = StarbridgeTheme.type.small, color = colors.fg)
        }
    }
}

package dev.starbridge.app.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.starbridge.app.data.Comparison
import dev.starbridge.app.data.JoinAsk
import dev.starbridge.app.protocol.formatDigits
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

class JoinActions(
    val compare: (String) -> Unit,
    val approve: () -> Unit,
    val refuse: (String) -> Unit,
    val close: () -> Unit,
)

/**
 * A browser or phone signed in to the account asks to join: compare the 6 digits it shows with
 * the ones here, then approve. Shown over any screen while the app is in front.
 */
@Composable
fun JoinPrompt(asks: List<JoinAsk>, comparison: Comparison, actions: JoinActions) {
    var later by rememberSaveable { mutableStateOf(listOf<String>()) }
    val colors = StarbridgeTheme.colors
    when (comparison) {
        Comparison.Idle -> {
            val ask = asks.firstOrNull { it.id !in later && !it.elsewhere } ?: return
            AlertDialog(
                onDismissRequest = { later = later + ask.id },
                title = { Text("Let ${ask.name} join?") },
                text = {
                    Text(
                        "A browser or phone signed in to your account asks to read and answer as a device. Compare digits with it before you approve.",
                        style = StarbridgeTheme.type.body,
                    )
                },
                confirmButton = { TextButton(onClick = { actions.compare(ask.id) }) { Text("Compare digits") } },
                dismissButton = {
                    Row {
                        TextButton(onClick = { later = later + ask.id }) { Text("Later") }
                        TextButton(onClick = { actions.refuse(ask.id) }) { Text("Refuse", color = colors.bad) }
                    }
                },
            )
        }
        is Comparison.Waiting -> AlertDialog(
            onDismissRequest = {},
            title = { Text("Let ${comparison.ask.name} join?") },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(Spacing.s5), color = colors.accent, strokeWidth = 2.dp)
                    Spacer(Modifier.width(Spacing.s3))
                    Text("Waiting for ${comparison.ask.name}…", style = StarbridgeTheme.type.body)
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { actions.refuse(comparison.ask.id) }) { Text("Refuse", color = colors.bad) } },
        )
        is Comparison.Digits -> AlertDialog(
            onDismissRequest = {},
            title = { Text("Same digits on ${comparison.ask.name}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                    Text("Approve only if ${comparison.ask.name} shows these same digits.", style = StarbridgeTheme.type.body)
                    Text(formatDigits(comparison.digits), style = StarbridgeTheme.type.figure, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    comparison.error?.let { Text(it, style = StarbridgeTheme.type.body, color = colors.bad) }
                }
            },
            confirmButton = {
                TextButton(onClick = actions.approve, enabled = !comparison.approving) {
                    if (comparison.approving) CircularProgressIndicator(Modifier.size(Spacing.s5), strokeWidth = 2.dp) else Text(if (comparison.error != null) "Try again" else "Approve")
                }
            },
            dismissButton = {
                TextButton(onClick = { actions.refuse(comparison.ask.id) }, enabled = !comparison.approving) { Text("Digits differ", color = colors.bad) }
            },
        )
        // One line: the title slot, with no empty text slot under it.
        is Comparison.Done -> AlertDialog(
            onDismissRequest = actions.close,
            title = { Text(comparison.message, textAlign = TextAlign.Center) },
            confirmButton = { TextButton(onClick = actions.close) { Text("OK") } },
        )
        is Comparison.Failed -> AlertDialog(
            onDismissRequest = actions.close,
            title = { Text("Not approved") },
            text = { Text(comparison.message, style = StarbridgeTheme.type.body) },
            confirmButton = { TextButton(onClick = actions.close) { Text("OK") } },
        )
    }
}

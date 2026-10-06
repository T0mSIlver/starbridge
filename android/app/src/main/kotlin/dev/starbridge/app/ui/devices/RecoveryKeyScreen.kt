package dev.starbridge.app.ui.devices

import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import dev.starbridge.app.data.Replacing
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.setup.Link
import dev.starbridge.app.ui.setup.Primary
import dev.starbridge.app.ui.setup.RecoveryKey
import dev.starbridge.app.ui.setup.SecureWindow
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

class RecoveryActions(
    /** Makes the new key, given the current one. */
    val make: (String) -> Unit,
    val save: () -> Unit,
    val close: () -> Unit,
)

/**
 * Replacing the recovery key (#348), with the current one: then the new key to write down, which
 * reaches the directory only once saved.
 */
@Composable
fun RecoveryKeyScreen(
    replacing: Replacing,
    busy: Boolean,
    actions: RecoveryActions,
    modifier: Modifier = Modifier,
    onBack: () -> Unit = {},
) {
    val leave = { actions.close(); onBack() }
    val saving = (replacing as? Replacing.Shown)?.saving == true
    BackHandler(onBack = { if (!saving) leave() })
    // However the screen goes (a tab, a notification), the keys go with it; a rotation keeps them.
    val activity = LocalActivity.current
    DisposableEffect(Unit) { onDispose { if (activity?.isChangingConfigurations != true) actions.close() } }
    when (replacing) {
        is Replacing.Shown -> Column(
            modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = Spacing.s4, end = Spacing.s4, bottom = Spacing.s10),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            RecoveryKey(
                replacing.key,
                actions.save,
                title = "Your new recovery key",
                text = "Write this key down and keep it offline. The old key works until you save this one.",
                action = "Save the new key",
                busy = replacing.saving,
            )
            if (!replacing.saving) Link("Cancel", leave)
        }
        Replacing.Done -> Page("Recovery key", modifier, onBack = leave) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
                    Text("Recovery key replaced", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface)
                    Text(
                        "The old key no longer works. Your devices are not affected.",
                        style = StarbridgeTheme.type.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Primary("Back to Devices", busy = false, onClick = leave)
                }
            }
        }
        Replacing.Idle -> Ask(busy, actions, modifier, leave)
    }
}

@Composable
private fun Ask(busy: Boolean, actions: RecoveryActions, modifier: Modifier, onBack: () -> Unit) {
    // Not saveable: the typed key stays out of the saved instance state.
    var typedKey by remember { mutableStateOf("") }
    var shown by rememberSaveable { mutableStateOf(false) }
    val reading = RecoveryKeys.read(typedKey)
    SecureWindow()
    Page("Recovery key", modifier, onBack = onBack) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
                Text(
                    "You get a new key to write down. Once it is saved, the old key stops working. Your devices are not affected.",
                    style = StarbridgeTheme.type.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextField(
                    value = typedKey,
                    onValueChange = { typedKey = it },
                    singleLine = true,
                    label = { Text("Your current recovery key") },
                    placeholder = { Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX") },
                    supportingText = { Text(reading.problem ?: reading.status) },
                    isError = reading.problem != null,
                    textStyle = StarbridgeTheme.type.machine,
                    colors = fieldColors(),
                    visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { shown = !shown }) { Symbol(Sym.Visibility, filled = shown, contentDescription = if (shown) "Hide the key" else "Show the key") }
                    },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Primary("Make a new key", busy, enabled = reading.complete) { actions.make(typedKey) }
                Text(
                    "Lost it? Without the current key it can't be replaced. Your devices keep working.",
                    style = StarbridgeTheme.type.small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

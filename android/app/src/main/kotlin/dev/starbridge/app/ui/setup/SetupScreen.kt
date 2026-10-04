package dev.starbridge.app.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.BuildConfig
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import javax.inject.Inject

@HiltViewModel
class SetupViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val busy = store.busy
    val server = store.server
    val actions = SetupActions(
        gitHub = store::gitHubSignInUrl,
        ownerToken = store::signInWithOwnerToken,
        firstDevice = store::setUpFirstDevice,
        join = store::joinAccount,
        cancelJoin = store::cancelJoin,
        recover = store::recover,
        saved = store::confirmRecoveryKey,
        signOut = store::signOut,
    )
}

class SetupActions(
    /** Returns the URL to open in the browser. */
    val gitHub: (server: String) -> String,
    val ownerToken: (server: String, token: String) -> Unit,
    val firstDevice: () -> Unit,
    val join: () -> Unit,
    val cancelJoin: () -> Unit,
    val recover: (words: String) -> Unit,
    val saved: () -> Unit,
    val signOut: () -> Unit,
)

/**
 * Before the phone is a device: sign in, then become the account's first device (and show the
 * recovery words once), join through another device's approval, or recover with the words.
 */
@Composable
fun SetupScreen(phase: Phase, server: String, busy: Boolean, actions: SetupActions, openUrl: (String) -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.s5, vertical = Spacing.s6),
        verticalArrangement = Arrangement.spacedBy(Spacing.s4),
    ) {
        when (phase) {
            Phase.SignedOut -> SignIn(server, busy, actions, openUrl)
            is Phase.NoDevice -> NoDevice(phase.accountExists, busy, actions)
            is Phase.Joining -> Joining(phase.code, actions.cancelJoin)
            is Phase.RecoveryKey -> RecoveryKey(phase.words, actions.saved)
            Phase.Ready -> Unit
        }
    }
}

/** A setup step's headline, in the type of a screen title. */
@Composable
private fun Title(text: String) {
    Text(text, style = StarbridgeTheme.type.title, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = Spacing.s8, bottom = Spacing.s1))
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Primary(text: String, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
    ) {
        if (busy) LoadingIndicator(Modifier.size(Spacing.s6), color = MaterialTheme.colorScheme.onSurfaceVariant)
        else Text(text, style = StarbridgeTheme.type.action)
    }
}

@Composable
private fun SignIn(server: String, busy: Boolean, actions: SetupActions, openUrl: (String) -> Unit) {
    var selfHosted by rememberSaveable { mutableStateOf(server != BuildConfig.DEFAULT_SERVER) }
    var url by rememberSaveable { mutableStateOf(server) }
    var token by rememberSaveable { mutableStateOf("") }
    Title("Starbridge")
    Text(
        "Answer your agents' questions and watch your AI plans' quotas, from this phone and the web.",
        style = StarbridgeTheme.type.body,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s2)) {
        Label("This phone makes its own keys")
        Spacer(Modifier.padding(top = Spacing.s2))
        Text(
            "Your agents encrypt every question to them, so the server stores only ciphertext. The keys never leave the phone.",
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
    Spacer(Modifier.padding(top = Spacing.s2))
    if (!selfHosted) {
        Primary("Sign in with GitHub", busy) { openUrl(actions.gitHub(BuildConfig.DEFAULT_SERVER)) }
        TextButton(onClick = { selfHosted = true }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Use your own server", style = StarbridgeTheme.type.action)
        }
    } else {
        TextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Server") },
            singleLine = true,
            textStyle = StarbridgeTheme.type.machine,
            colors = fieldColors(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        TextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Owner token") },
            supportingText = { Text("OWNER_TOKEN from the server's environment") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            colors = fieldColors(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        Primary("Sign in", busy, enabled = url.isNotBlank() && token.isNotBlank()) { actions.ownerToken(url, token) }
        OutlinedButton(
            onClick = { openUrl(actions.gitHub(url)) },
            enabled = url.isNotBlank() && !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
        ) { Text("Sign in with GitHub on this server", style = StarbridgeTheme.type.action) }
        TextButton(onClick = { selfHosted = false; url = BuildConfig.DEFAULT_SERVER }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Use starbridge.run", style = StarbridgeTheme.type.action)
        }
    }
}

@Composable
private fun NoDevice(accountExists: Boolean, busy: Boolean, actions: SetupActions) {
    var recovering by rememberSaveable { mutableStateOf(false) }
    var words by rememberSaveable { mutableStateOf("") }
    if (!accountExists) {
        Title("Your first device")
        Text(
            "This phone becomes the first device of your account. Next it shows a recovery key: 24 words that can add a new device if you ever lose every one.",
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Primary("Set up this phone", busy, onClick = actions.firstDevice)
    } else if (!recovering) {
        Title("Join your account")
        Text(
            "Your account already has devices. One of them approves this phone: it shows a code, which you type on the other device under Devices.",
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Primary("Show a code", busy, onClick = actions.join)
        TextButton(onClick = { recovering = true }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("I lost every device: use the recovery words", style = StarbridgeTheme.type.action)
        }
    } else {
        Title("Recover with the words")
        Text("Type the 24 words in order, separated by spaces.", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextField(
            value = words,
            onValueChange = { words = it },
            minLines = 4,
            textStyle = StarbridgeTheme.type.machine,
            colors = fieldColors(),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Primary("Recover", busy, enabled = words.trim().split(Regex("\\s+")).size == 24) { actions.recover(words) }
        TextButton(onClick = { recovering = false }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Back", style = StarbridgeTheme.type.action)
        }
    }
    TextButton(
        onClick = actions.signOut,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        modifier = Modifier.heightIn(min = Sizes.tap),
    ) { Text("Sign out", style = StarbridgeTheme.type.action) }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Joining(code: String, onCancel: () -> Unit) {
    Title("Approve this phone")
    Text(
        "On a device that's already set up, open Devices and type this code. It expires in 10 minutes.",
        style = StarbridgeTheme.type.body,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Panel(Modifier.fillMaxWidth().padding(vertical = Spacing.s2)) {
        Text(code, style = StarbridgeTheme.type.figure, color = MaterialTheme.colorScheme.onSurface)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        LoadingIndicator(Modifier.size(Spacing.s8), color = MaterialTheme.colorScheme.secondary)
        Spacer(Modifier.width(Spacing.s3))
        Text("Waiting for the approval", style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Cancel", style = StarbridgeTheme.type.action) }
}

@Composable
private fun RecoveryKey(words: List<String>, onDone: () -> Unit) {
    val colors = StarbridgeTheme.colors
    var saved by rememberSaveable { mutableStateOf(false) }
    Title("Your recovery key")
    Text(
        "Write these ${words.size} words down and keep them offline. If you lose every device, they add a new one. This is the only time they are shown.",
        style = StarbridgeTheme.type.body,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s2)) {
        words.chunked(3).forEachIndexed { row, three ->
            Row(Modifier.padding(vertical = Spacing.s1)) {
                three.forEachIndexed { col, word ->
                    Row(Modifier.weight(1f)) {
                        Text("${row * 3 + col + 1}".padStart(2), style = StarbridgeTheme.type.machine, color = colors.fg3)
                        Spacer(Modifier.width(Spacing.s2))
                        Text(word, style = StarbridgeTheme.type.machine, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = Sizes.tap).toggleable(value = saved, role = Role.Checkbox, onValueChange = { saved = it }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = saved, onCheckedChange = null)
        Spacer(Modifier.width(Spacing.s3))
        Text("I wrote these words down", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
    }
    Primary("Continue", busy = false, enabled = saved, onClick = onDone)
}

package dev.starbridge.app.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.BuildConfig
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.pairing.rememberScanner
import dev.starbridge.app.protocol.formatDigits
import dev.starbridge.app.ui.theme.Radius
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
        joinWithCode = store::joinWithCode,
        askDevices = store::askDevices,
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
    /** A scanned pairing link, from another device's QR code. */
    val joinWithCode: (String) -> Unit,
    val askDevices: () -> Unit,
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
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        when (phase) {
            Phase.SignedOut -> SignIn(server, busy, actions, openUrl)
            is Phase.NoDevice -> NoDevice(phase.accountExists, busy, actions)
            is Phase.Joining -> Joining(phase.code, phase.scanned, actions.cancelJoin)
            is Phase.JoiningByDigits -> JoiningByDigits(phase.digits, actions.cancelJoin)
            is Phase.RecoveryKey -> RecoveryKey(phase.words, actions.saved)
            Phase.Ready -> Unit
        }
    }
}

@Composable
private fun Primary(text: String, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = RoundedCornerShape(Radius.pill),
        modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
    ) {
        if (busy) CircularProgressIndicator(Modifier.width(Spacing.s5), color = colors.fg2, strokeWidth = 2.dp)
        else Text(text, style = StarbridgeTheme.type.action)
    }
}

@Composable
private fun SignIn(server: String, busy: Boolean, actions: SetupActions, openUrl: (String) -> Unit) {
    val colors = StarbridgeTheme.colors
    var selfHosted by rememberSaveable { mutableStateOf(server != BuildConfig.DEFAULT_SERVER) }
    var url by rememberSaveable { mutableStateOf(server) }
    var token by rememberSaveable { mutableStateOf("") }
    Title("Starbridge")
    Text(
        "Answer your agents' questions and watch your AI plans' quotas, from this phone and the web.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s4)) {
        Label("This phone makes its own keys")
        Spacer(Modifier.padding(top = Spacing.s2))
        Text(
            "Your agents encrypt every question to them, so the server stores only ciphertext. The keys never leave the phone.",
            style = StarbridgeTheme.type.body,
            color = colors.fg,
        )
    }
    Spacer(Modifier.padding(top = Spacing.s2))
    if (!selfHosted) {
        Primary("Sign in with GitHub", busy) { openUrl(actions.gitHub(BuildConfig.DEFAULT_SERVER)) }
        TextButton(onClick = { selfHosted = true }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Use your own server", style = StarbridgeTheme.type.action)
        }
    } else {
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Server") },
            singleLine = true,
            textStyle = StarbridgeTheme.type.machine,
            shape = RoundedCornerShape(Radius.md),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Owner token") },
            supportingText = { Text("OWNER_TOKEN from the server's environment") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            shape = RoundedCornerShape(Radius.md),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        Primary("Sign in", busy, enabled = url.isNotBlank() && token.isNotBlank()) { actions.ownerToken(url, token) }
        OutlinedButton(
            onClick = { openUrl(actions.gitHub(url)) },
            enabled = url.isNotBlank() && !busy,
            shape = RoundedCornerShape(Radius.pill),
            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
        ) { Text("Sign in with GitHub on this server", style = StarbridgeTheme.type.action) }
        TextButton(onClick = { selfHosted = false; url = BuildConfig.DEFAULT_SERVER }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Use starbridge.run", style = StarbridgeTheme.type.action)
        }
    }
}

@Composable
private fun NoDevice(accountExists: Boolean, busy: Boolean, actions: SetupActions) {
    val colors = StarbridgeTheme.colors
    var recovering by rememberSaveable { mutableStateOf(false) }
    var words by rememberSaveable { mutableStateOf("") }
    if (!accountExists) {
        Title("Your first device")
        Text(
            "This phone becomes the first device of your account. Next it shows a recovery key: 24 words that can add a new device if you ever lose every one.",
            style = StarbridgeTheme.type.body,
            color = colors.fg2,
        )
        Primary("Set up this phone", busy, onClick = actions.firstDevice)
    } else if (!recovering) {
        var scanError by rememberSaveable { mutableStateOf<String?>(null) }
        val scan = rememberScanner(onResult = { scanError = null; actions.joinWithCode(it) }, onError = { scanError = it })
        Title("Join your account")
        Text(
            "Your account already has devices. One of them approves this phone: it compares digits with this phone, or shows a QR code under Devices for this phone to scan.",
            style = StarbridgeTheme.type.body,
            color = colors.fg2,
        )
        Primary("Ask my other devices", busy, onClick = actions.askDevices)
        OutlinedButton(
            onClick = scan,
            enabled = !busy,
            shape = RoundedCornerShape(Radius.pill),
            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
        ) { Text("Scan a QR code", style = StarbridgeTheme.type.action) }
        scanError?.let { Text(it, style = StarbridgeTheme.type.small, color = colors.bad) }
        TextButton(onClick = actions.join, enabled = !busy, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Show a code to type instead", style = StarbridgeTheme.type.action)
        }
        TextButton(onClick = { recovering = true }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("I lost every device: use the recovery words", style = StarbridgeTheme.type.action)
        }
    } else {
        Title("Recover with the words")
        Text("Type the 24 words in order, separated by spaces.", style = StarbridgeTheme.type.body, color = colors.fg2)
        OutlinedTextField(
            value = words,
            onValueChange = { words = it },
            minLines = 4,
            textStyle = StarbridgeTheme.type.machine,
            shape = RoundedCornerShape(Radius.md),
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
        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
        modifier = Modifier.heightIn(min = Sizes.tap),
    ) { Text("Sign out", style = StarbridgeTheme.type.action) }
}

@Composable
private fun Joining(code: String, scanned: Boolean, onCancel: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Title("Approve this phone")
    Text(
        if (scanned) "The device that shows the QR code asks whether to let this phone join. Approve it there." else "On a device that's already set up, open Devices and type this code. It expires in 10 minutes.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    Panel(Modifier.fillMaxWidth().padding(vertical = Spacing.s2), border = colors.accent) {
        Text(code, style = StarbridgeTheme.type.figure, color = colors.fg)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.width(Spacing.s5), color = colors.accent, strokeWidth = 2.dp)
        Spacer(Modifier.width(Spacing.s3))
        Text("Waiting for the approval", style = StarbridgeTheme.type.small, color = colors.fg2)
    }
    TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Cancel", style = StarbridgeTheme.type.action) }
}

@Composable
private fun JoiningByDigits(digits: String?, onCancel: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Title("Approve this phone")
    Text(
        if (digits == null) "Open Starbridge on a device you already use. It asks whether to let this phone join; tap Compare digits there."
        else "Check that your other device shows these digits, then approve this phone there.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    if (digits != null) {
        Panel(Modifier.fillMaxWidth().padding(vertical = Spacing.s2), border = colors.accent) {
            Text(formatDigits(digits), style = StarbridgeTheme.type.figure, color = colors.fg)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.width(Spacing.s5), color = colors.accent, strokeWidth = 2.dp)
        Spacer(Modifier.width(Spacing.s3))
        Text("Waiting for the approval", style = StarbridgeTheme.type.small, color = colors.fg2)
    }
    TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = Sizes.tap)) {
        Text(if (digits == null) "Cancel" else "Digits differ: cancel", style = StarbridgeTheme.type.action)
    }
}

@Composable
private fun RecoveryKey(words: List<String>, onDone: () -> Unit) {
    val colors = StarbridgeTheme.colors
    var saved by rememberSaveable { mutableStateOf(false) }
    Title("Your recovery key")
    Text(
        "Write these ${words.size} words down and keep them offline. If you lose every device, they add a new one. This is the only time they are shown.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s2), border = colors.lineStrong) {
        words.chunked(3).forEachIndexed { row, three ->
            Row(Modifier.padding(vertical = Spacing.s1)) {
                three.forEachIndexed { col, word ->
                    Row(Modifier.weight(1f)) {
                        Text("${row * 3 + col + 1}".padStart(2), style = StarbridgeTheme.type.machine, color = colors.fg3)
                        Spacer(Modifier.width(Spacing.s2))
                        Text(word, style = StarbridgeTheme.type.machine, color = colors.fg)
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
        Text("I wrote these words down", style = StarbridgeTheme.type.body, color = colors.fg)
    }
    Primary("Continue", busy = false, enabled = saved, onClick = onDone)
}

package dev.starbridge.app.ui.setup

import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.runtime.DisposableEffect
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import dev.starbridge.app.protocol.RecoveryKeys
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import dev.starbridge.app.ui.Lockup
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.pairing.rememberScanner
import dev.starbridge.app.protocol.formatDigits
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.R
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
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
        confirmDigits = store::confirmDigits,
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
    val recover: (key: String) -> Unit,
    val saved: () -> Unit,
    val signOut: () -> Unit,
    val confirmDigits: () -> Unit = {},
)

/**
 * Before the phone is a device: sign in, then join by scanning another device's QR code (digits
 * are the fallback), or, on an empty account, create its keys and show the recovery key once.
 */
@Composable
fun SetupScreen(phase: Phase, server: String, busy: Boolean, actions: SetupActions, openUrl: (String) -> Unit, modifier: Modifier = Modifier) {
    when (phase) {
        Phase.SignedOut -> SignIn(server, busy, actions, openUrl, modifier)
        is Phase.NoDevice -> if (phase.accountExists) Join(busy, actions, modifier) else FirstDevice(busy, actions, modifier)
        is Phase.Joining -> Waiting("Approve this phone", if (phase.scanned) "Approve it on the device that shows the QR code." else "Type this code on a device you already use: ${phase.code}", null, actions.cancelJoin, modifier)
        is Phase.JoiningByDigits -> when {
            phase.digits != null && !phase.matched -> Waiting("Compare digits", "Does your other device show the same digits?", phase.digits, actions.cancelJoin, modifier, onMatch = actions.confirmDigits)
            phase.digits != null -> Waiting("Compare digits", "Approve on your other device.", phase.digits, actions.cancelJoin, modifier)
            else -> Waiting("Compare digits", "Approve on your other device if the digits match.", null, actions.cancelJoin, modifier)
        }
        is Phase.RecoveryKey -> Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = Spacing.s4, end = Spacing.s4, bottom = Spacing.s10), verticalArrangement = Arrangement.spacedBy(Spacing.s4)) { RecoveryKey(phase.shown, actions.saved) }
        Phase.Ready -> Unit
    }
}

/** A setup step: [top] from the top, its actions pinned at the bottom, as the mockups lay them out. */
@Composable
private fun Step(modifier: Modifier, top: @Composable ColumnScope.() -> Unit, bottom: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.fillMaxWidth(), content = top)
        Spacer(Modifier.weight(1f).heightIn(min = Spacing.s8))
        Column(Modifier.fillMaxWidth().padding(start = Spacing.s4, end = Spacing.s4, bottom = Spacing.s10), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.s3), content = bottom)
    }
}

/** A setup step's headline. */
@Composable
private fun Title(text: String, modifier: Modifier = Modifier) {
    Text(text, style = StarbridgeTheme.type.title, color = MaterialTheme.colorScheme.onSurface, modifier = modifier)
}

/** The main action: filled in `fg`, 56 dp, the full width. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Primary(text: String, busy: Boolean, enabled: Boolean = true, icon: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled && !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
        if (busy) {
            LoadingIndicator(Modifier.size(Spacing.s6), color = MaterialTheme.colorScheme.onPrimary)
        } else {
            icon?.let { it(); Spacer(Modifier.width(Spacing.s2)) }
            Text(text, style = StarbridgeTheme.type.action)
        }
    }
}

/** A quieter way: underlined text. */
@Composable
private fun Link(text: String, onClick: () -> Unit) {
    Text(
        text,
        style = StarbridgeTheme.type.small.copy(textDecoration = TextDecoration.Underline),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.clickable(onClick = onClick).padding(vertical = Spacing.s1),
    )
}

/** The step's picture: a symbol on a rounded tile, on a card. */
@Composable
private fun Tile(sym: Sym) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = Spacing.s3), shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Box(Modifier.padding(Spacing.s10), contentAlignment = Alignment.Center) {
            Box(Modifier.size(120.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(32.dp)), contentAlignment = Alignment.Center) {
                Symbol(sym, size = 56.dp, tint = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}

@Composable
private fun SignIn(server: String, busy: Boolean, actions: SetupActions, openUrl: (String) -> Unit, modifier: Modifier) {
    var selfHosted by rememberSaveable { mutableStateOf(server != BuildConfig.DEFAULT_SERVER) }
    var url by rememberSaveable { mutableStateOf(server) }
    var token by rememberSaveable { mutableStateOf("") }
    Step(
        modifier,
        top = {
            Lockup(56.dp, 40.sp, Modifier.padding(start = Spacing.s6, top = 120.dp))
            if (selfHosted) {
                Column(Modifier.padding(start = Spacing.s4, end = Spacing.s4, top = Spacing.s8), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
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
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        colors = fieldColors(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        bottom = {
            if (!selfHosted) {
                Primary("Sign in with GitHub", busy, icon = { Icon(painterResource(R.drawable.ic_github), contentDescription = null, modifier = Modifier.size(20.dp)) }) {
                    openUrl(actions.gitHub(BuildConfig.DEFAULT_SERVER))
                }
                Link("Use your own server") { selfHosted = true }
            } else {
                Primary("Sign in", busy, enabled = url.isNotBlank() && token.isNotBlank()) { actions.ownerToken(url, token) }
                OutlinedButton(onClick = { openUrl(actions.gitHub(url)) }, enabled = url.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Text("Sign in with GitHub on this server", style = StarbridgeTheme.type.action)
                }
                Link("Use starbridge.run") { selfHosted = false; url = BuildConfig.DEFAULT_SERVER }
            }
        },
    )
}

/** The account has devices: this phone scans one's QR code, or compares digits with it. */
@Composable
private fun Join(busy: Boolean, actions: SetupActions, modifier: Modifier) {
    var recovering by rememberSaveable { mutableStateOf(false) }
    var scanError by rememberSaveable { mutableStateOf<String?>(null) }
    val scan = rememberScanner(onResult = { scanError = null; actions.joinWithCode(it) }, onError = { scanError = it })
    if (recovering) return Recover(busy, actions, modifier) { recovering = false }
    Step(
        modifier,
        top = {
            Title("Add this phone", Modifier.padding(start = Spacing.s4, top = 48.dp, bottom = Spacing.s6))
            Tile(Sym.Qr)
            scanError?.let { Text(it, style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(Spacing.s4)) }
        },
        bottom = {
            Primary("Scan a QR code", busy, icon = { Symbol(Sym.Qr, size = 20.dp) }, onClick = scan)
            Link("Can't scan? Compare digits", actions.askDevices)
            // 24 dp under the link above, so each keeps a 48 dp tap area at every font size.
            FlowRow(Modifier.padding(top = Spacing.s3), horizontalArrangement = Arrangement.spacedBy(Spacing.s6, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(Spacing.s6)) {
                Link("Use the recovery key") { recovering = true }
                Link("Sign out", actions.signOut)
            }
        },
    )
}

/** An empty account: this phone creates its keys. */
@Composable
private fun FirstDevice(busy: Boolean, actions: SetupActions, modifier: Modifier) {
    Step(
        modifier,
        top = {
            Column(Modifier.padding(start = Spacing.s4, end = Spacing.s4, top = 48.dp, bottom = Spacing.s6), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                Title("Set up your account")
                Text("This phone creates your account's keys.", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Tile(Sym.Key)
        },
        bottom = {
            Primary("Create the keys", busy, onClick = actions.firstDevice)
            Link("Sign out", actions.signOut)
        },
    )
}

@Composable
private fun Recover(busy: Boolean, actions: SetupActions, modifier: Modifier, onBack: () -> Unit) {
    var typedKey by rememberSaveable { mutableStateOf("") }
    var shown by rememberSaveable { mutableStateOf(false) }
    val reading = RecoveryKeys.read(typedKey)
    SecureWindow()
    Step(
        modifier,
        top = {
            Column(Modifier.padding(start = Spacing.s4, end = Spacing.s4, top = 48.dp), verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
                Title("Recovery key")
                TextField(
                    value = typedKey,
                    onValueChange = { typedKey = it },
                    singleLine = true,
                    label = { Text("Your recovery key") },
                    placeholder = { Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX") },
                    supportingText = { Text(reading.problem ?: reading.status) },
                    isError = reading.problem != null,
                    textStyle = StarbridgeTheme.type.machine,
                    // The default label reads at 4.4:1 on the field; this one clears 4.5:1.
                    colors = fieldColors().copy(unfocusedLabelColor = MaterialTheme.colorScheme.onSurface),
                    // Masked as a password, with the eye to check what was typed (#274).
                    visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { shown = !shown }) { Symbol(Sym.Visibility, filled = shown, contentDescription = if (shown) "Hide the key" else "Show the key") }
                    },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        bottom = {
            Primary("Recover", busy, enabled = reading.complete) { actions.recover(typedKey) }
            Link("Back", onBack)
        },
    )
}

/**
 * Waiting for another device to approve this one: the six digits to compare when there are
 * some, two groups of three, and the expressive loading indicator.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Waiting(title: String, text: String, digits: String?, onCancel: () -> Unit, modifier: Modifier, onMatch: (() -> Unit)? = null) {
    Step(
        modifier,
        top = {
            IconButton(onClick = onCancel, modifier = Modifier.padding(start = Spacing.s1, top = Spacing.s2)) { Symbol(Sym.Back, size = 22.dp, tint = MaterialTheme.colorScheme.onSurface, contentDescription = "Back") }
            Column(Modifier.padding(start = Spacing.s4, end = Spacing.s4, top = Spacing.s2), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                Title(title)
                Text(text, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (digits != null) {
                Surface(Modifier.fillMaxWidth().padding(start = Spacing.s3, end = Spacing.s3, top = Spacing.s6), shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
                    Row(Modifier.padding(horizontal = Spacing.s6, vertical = 28.dp), horizontalArrangement = Arrangement.Center) {
                        digits.forEachIndexed { i, d ->
                            if (i == 3) Spacer(Modifier.width(Spacing.s3))
                            if (i > 0) Spacer(Modifier.width(Spacing.s2))
                            // Narrower than 48 dp only where six of them don't fit.
                            Box(Modifier.weight(1f, fill = false).widthIn(max = 48.dp).fillMaxWidth().height(64.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                                Text("$d", style = StarbridgeTheme.type.figure.copy(fontSize = 32.sp, lineHeight = 32.sp), color = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                    }
                }
            }
            if (onMatch == null) {
                Row(Modifier.padding(horizontal = Spacing.s6, vertical = 28.dp), verticalAlignment = Alignment.CenterVertically) {
                    LoadingIndicator(Modifier.size(40.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(Spacing.s4))
                    Text("Waiting for the approval", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        bottom = {
            if (onMatch != null) Button(onClick = onMatch, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("They match", style = StarbridgeTheme.type.action) }
            OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Cancel", style = StarbridgeTheme.type.action) }
        },
    )
}

@Composable
private fun RecoveryKey(shown: String, onDone: () -> Unit) {
    SecureWindow()
    var saved by rememberSaveable { mutableStateOf(false) }
    Title("Your recovery key", Modifier.padding(top = 48.dp))
    Text(
        "Write this key down and keep it offline. If you lose every device, it adds a new one. This is the only time it is shown.",
        style = StarbridgeTheme.type.body,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s2)) {
        // Groups of four, two or three to a line, never split.
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.s4, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            shown.split("-", " ").forEach { group ->
                Text(group, style = StarbridgeTheme.type.machine.copy(fontSize = 22.sp, letterSpacing = 2.sp), color = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = Sizes.tap).toggleable(value = saved, role = Role.Checkbox, onValueChange = { saved = it }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = saved, onCheckedChange = null)
        Spacer(Modifier.width(Spacing.s3))
        Text("I wrote this key down", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
    }
    Primary("Continue", busy = false, enabled = saved, onClick = onDone)
}

/** While shown, the window stays out of screenshots, screen sharing and the recents screen. */
@Composable
private fun SecureWindow() {
    val window = LocalActivity.current?.window ?: return
    DisposableEffect(window) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
}

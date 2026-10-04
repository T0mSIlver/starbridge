package dev.starbridge.app.ui.devices

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.pairing.QrImage
import dev.starbridge.app.ui.pairing.rememberScanner
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class DevicesViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val members = store.members
    val approval = store.approval
    val push = store.push
    val server = store.server
    val actions = DeviceActions(store::lookUpPairing, store::approvePairing, store::closePairing, store::revoke, store::setPushType, store::signOut, store::showCode)
}

class DeviceActions(
    val lookUp: (String) -> Unit,
    val approve: () -> Unit,
    val close: () -> Unit,
    val revoke: (String) -> Unit,
    val setPush: (String) -> Unit,
    val signOut: () -> Unit,
    val showCode: () -> Unit,
)

/** Pairing first, then the devices that read decisions and the machines that post them. */
@Composable
fun DevicesScreen(
    members: List<Member>,
    approval: Approval,
    push: PushSetting,
    server: String,
    now: Instant,
    actions: DeviceActions,
    modifier: Modifier = Modifier,
) {
    val devices = members.filter { it.kind == Kind.Device }
    val machines = members.filter { it.kind == Kind.Machine }
    var revoking by rememberSaveable { mutableStateOf<String?>(null) }
    var signingOut by rememberSaveable { mutableStateOf(false) }
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        item { Title("Devices and machines") }
        item { PairCard(approval, actions) }
        item { Label("Devices", Modifier.padding(top = Spacing.s2)) }
        items(devices, key = { it.id }) { MemberRow(it, now) { revoking = it.id } }
        item { Label("Machines", Modifier.padding(top = Spacing.s2)) }
        if (machines.isEmpty()) {
            item { Text("None yet. Run starbridge pair on a machine and type its code above.", style = StarbridgeTheme.type.small, color = StarbridgeTheme.colors.fg3) }
        }
        items(machines, key = { it.id }) { MemberRow(it, now) { revoking = it.id } }
        item { Label("This phone", Modifier.padding(top = Spacing.s4)) }
        item { ThisPhone(push, server, actions.setPush) { signingOut = true } }
    }
    revoking?.let { id ->
        val name = members.find { it.id == id }?.name ?: id
        Confirm(
            title = "Revoke $name?",
            text = "It stops receiving decisions and quotas, and can no longer post or answer. To bring it back, pair it again.",
            action = "Revoke",
            onConfirm = { actions.revoke(id); revoking = null },
            onDismiss = { revoking = null },
        )
    }
    if (signingOut) {
        Confirm(
            title = "Sign out?",
            text = "This phone forgets its keys and leaves your devices. If it is your only device, you will need the recovery words to set up another.",
            action = "Sign out",
            onConfirm = { actions.signOut(); signingOut = false },
            onDismiss = { signingOut = false },
        )
    }
}

@Composable
private fun Confirm(title: String, text: String, action: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text, style = StarbridgeTheme.type.body) },
        confirmButton = {
            TextButton(onClick = onConfirm, colors = ButtonDefaults.textButtonColors(contentColor = StarbridgeTheme.colors.bad)) { Text(action) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Typing a new member's code: the request is checked against the code's secret before anything
 * is shown, and approving appends its keys to the directory.
 */
@Composable
fun PairCard(approval: Approval, actions: DeviceActions) {
    val colors = StarbridgeTheme.colors
    var code by rememberSaveable { mutableStateOf("") }
    val scan = rememberScanner(onResult = { code = it.substringAfter('#'); actions.lookUp(it) }, onError = { code = "" })
    val found = approval is Approval.Found || approval is Approval.Approving
    Panel(Modifier.fillMaxWidth(), border = if (found) colors.accent else colors.line) {
        AnimatedContent(approval, contentKey = { it::class }, label = "pairing") { state ->
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                when (state) {
                    is Approval.Found, is Approval.Approving -> {
                        val f = state as? Approval.Found ?: (state as Approval.Approving).found
                        Label("Wants to join", color = colors.accent)
                        Text(f.name, style = StarbridgeTheme.type.question, color = colors.fg)
                        Text(
                            if (f.kind == Kind.Machine) "A machine: its agents can ask you decisions and send quotas." else "A device: it can read and answer decisions.",
                            style = StarbridgeTheme.type.body,
                            color = colors.fg2,
                        )
                        Text(f.code, style = StarbridgeTheme.type.machine, color = colors.fg3)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Button(
                                onClick = actions.approve,
                                enabled = state is Approval.Found,
                                shape = RoundedCornerShape(Radius.pill),
                                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
                                modifier = Modifier.weight(1f).heightIn(min = Sizes.tap),
                            ) {
                                if (state is Approval.Approving) CircularProgressIndicator(Modifier.size(Spacing.s5), color = colors.onAccent, strokeWidth = 2.dp)
                                else Text("Approve", style = StarbridgeTheme.type.action)
                            }
                            Spacer(Modifier.padding(start = Spacing.s2))
                            TextButton(onClick = { actions.close(); code = "" }, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Cancel", style = StarbridgeTheme.type.action) }
                        }
                    }
                    is Approval.Showing -> {
                        Label("Scan with the new phone", color = colors.accent)
                        Text("On the new phone, sign in to Starbridge and tap Scan a QR code. It expires in 10 minutes.", style = StarbridgeTheme.type.small, color = colors.fg2)
                        QrImage(state.link, "QR code for pairing code ${state.code}")
                        Text(state.code, style = StarbridgeTheme.type.machine, color = colors.fg3)
                        TextButton(onClick = { actions.close(); code = "" }, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Cancel", style = StarbridgeTheme.type.action) }
                    }
                    is Approval.Done -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = colors.ok)
                            Spacer(Modifier.padding(start = Spacing.s2))
                            Text("${state.name} joined.", style = StarbridgeTheme.type.body, color = colors.fg)
                        }
                        TextButton(onClick = { actions.close(); code = "" }) { Text("Pair another", style = StarbridgeTheme.type.action) }
                    }
                    else -> {
                        Label("Add a machine or device")
                        Text("Scan or type the code it shows: starbridge pair on a machine, or Join on a new phone or browser. Or show a QR code for a new phone to scan.", style = StarbridgeTheme.type.small, color = colors.fg2)
                        OutlinedTextField(
                            value = code,
                            onValueChange = { code = it.take(40) },
                            placeholder = { Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX") },
                            singleLine = true,
                            textStyle = StarbridgeTheme.type.machine,
                            shape = RoundedCornerShape(Radius.md),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { actions.lookUp(code) }),
                            modifier = Modifier.fillMaxWidth(),
                            isError = state is Approval.Failed,
                            supportingText = (state as? Approval.Failed)?.let { { Text(it.message) } },
                        )
                        Button(
                            onClick = { actions.lookUp(code) },
                            enabled = code.isNotBlank() && state != Approval.Checking,
                            shape = RoundedCornerShape(Radius.pill),
                            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
                        ) { Text(if (state == Approval.Checking) "Checking…" else "Check code", style = StarbridgeTheme.type.action) }
                        Row {
                            TextButton(onClick = scan, modifier = Modifier.weight(1f).heightIn(min = Sizes.tap)) { Text("Scan a QR code", style = StarbridgeTheme.type.action) }
                            TextButton(onClick = actions.showCode, modifier = Modifier.weight(1f).heightIn(min = Sizes.tap)) { Text("Show a QR code", style = StarbridgeTheme.type.action) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MemberRow(member: Member, now: Instant, onRevoke: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (member.kind == Kind.Machine) Icons.Rounded.Computer else Icons.Rounded.Devices, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(Spacing.s6))
            Spacer(Modifier.padding(start = Spacing.s3))
            Column(Modifier.weight(1f)) {
                Text(member.name, style = if (member.kind == Kind.Machine) StarbridgeTheme.type.machine else StarbridgeTheme.type.body, color = colors.fg)
                Text(if (member.current) "This phone" else "Added ${ago(now, member.addedAt)}", style = StarbridgeTheme.type.small, color = colors.fg3)
            }
            if (!member.current) {
                TextButton(
                    onClick = onRevoke,
                    modifier = Modifier.heightIn(min = Sizes.tap),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.bad),
                ) { Text("Revoke", style = StarbridgeTheme.type.action) }
            }
        }
    }
}

/** How pushes arrive, the server, and signing out. */
@Composable
private fun ThisPhone(push: PushSetting, server: String, onPush: (String) -> Unit, onSignOut: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth()) {
        Text("Notifications through", style = StarbridgeTheme.type.body, color = colors.fg)
        Spacer(Modifier.padding(top = Spacing.s2))
        val choices = listOf("fcm" to "Google", "unifiedpush" to "UnifiedPush")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            choices.forEachIndexed { i, (type, label) ->
                SegmentedButton(
                    selected = push.type == type,
                    onClick = { onPush(type) },
                    shape = SegmentedButtonDefaults.itemShape(i, choices.size),
                ) { Text(label, style = StarbridgeTheme.type.action) }
            }
        }
        Spacer(Modifier.padding(top = Spacing.s2))
        val status = when {
            push.registered -> "Registered with your server."
            push.type == "unifiedpush" && push.distributors.isEmpty() -> "Install a UnifiedPush distributor, such as ntfy, then pick UnifiedPush again."
            push.type == "fcm" && !push.fcmAvailable -> "This build has no Firebase project; pick UnifiedPush."
            else -> "Not registered yet."
        }
        Text(status, style = StarbridgeTheme.type.small, color = if (push.registered) colors.fg2 else colors.warn)
        Spacer(Modifier.padding(top = Spacing.s3))
        Text(server, style = StarbridgeTheme.type.machine, color = colors.fg3)
        TextButton(onClick = onSignOut, colors = ButtonDefaults.textButtonColors(contentColor = colors.bad), modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Sign out", style = StarbridgeTheme.type.action)
        }
    }
    Spacer(Modifier.padding(top = Spacing.s2))
    Text(
        "The recovery words were shown once, when you set up your first device. They can add a new device if you lose all of them.",
        style = StarbridgeTheme.type.small,
        color = colors.fg3,
    )
}

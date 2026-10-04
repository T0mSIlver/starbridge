package dev.starbridge.app.ui.devices

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Beacon
import dev.starbridge.app.ui.Choice
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Screen
import dev.starbridge.app.ui.StatusWord
import dev.starbridge.app.ui.ago
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.groupGap
import dev.starbridge.app.ui.groupShape
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject

@HiltViewModel
class DevicesViewModel @Inject constructor(private val store: Store, prefs: Prefs) : ViewModel() {
    val members = store.members
    val approval = store.approval
    val push = store.push
    val server = store.server
    val colours = prefs.colours
    val actions = DeviceActions(store::lookUpPairing, store::approvePairing, store::closePairing, store::revoke, store::setPushType, store::signOut, prefs::setColours)
}

class DeviceActions(
    val lookUp: (String) -> Unit,
    val approve: () -> Unit,
    val close: () -> Unit,
    val revoke: (String) -> Unit,
    val setPush: (String) -> Unit,
    val signOut: () -> Unit,
    val setColours: (Colours) -> Unit,
)

/** Pairing first, then the devices that read decisions, the machines that post them, and this phone. */
@Composable
fun DevicesScreen(
    members: List<Member>,
    approval: Approval,
    push: PushSetting,
    server: String,
    now: Instant,
    actions: DeviceActions,
    modifier: Modifier = Modifier,
    colours: Colours = Colours.Starbridge,
    otherWaysToPair: @Composable ColumnScope.() -> Unit = {},
) {
    val devices = members.filter { it.kind == Kind.Device }
    val machines = members.filter { it.kind == Kind.Machine }
    var revoking by rememberSaveable { mutableStateOf<String?>(null) }
    var signingOut by rememberSaveable { mutableStateOf(false) }
    Screen("Devices", modifier) { padding ->
        LazyColumn(
            contentPadding = listPadding(padding),
            verticalArrangement = Arrangement.spacedBy(groupGap),
        ) {
            item { PairCard(approval, actions, otherWaysToPair) }
            item { Section("Devices") }
            itemsIndexed(devices, key = { _, it -> it.id }) { i, it -> MemberRow(it, now, groupShape(i, devices.size)) { revoking = it.id } }
            item { Section("Machines") }
            if (machines.isEmpty()) {
                item { Text("None yet. Run starbridge pair on a machine and type its code above.", style = StarbridgeTheme.type.small, color = StarbridgeTheme.colors.fg2, modifier = Modifier.padding(horizontal = Spacing.s1)) }
            }
            itemsIndexed(machines, key = { _, it -> it.id }) { i, it -> MemberRow(it, now, groupShape(i, machines.size)) { revoking = it.id } }
            item { Section("This phone") }
            item { Notifications(push, actions.setPush, groupShape(0, 3)) }
            item { ColoursSetting(colours, actions.setColours, groupShape(1, 3)) }
            item { Account(server, groupShape(2, 3)) { signingOut = true } }
            item {
                Text(
                    "The recovery words were shown once, when you set up your first device. They can add a new device if you lose all of them.",
                    style = StarbridgeTheme.type.small,
                    color = StarbridgeTheme.colors.fg2,
                    modifier = Modifier.padding(top = Spacing.s3, start = Spacing.s1, end = Spacing.s1),
                )
            }
        }
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

/** A group's name, above its rows. */
@Composable
private fun Section(text: String) {
    Label(text, Modifier.padding(start = Spacing.s1, top = Spacing.s6, bottom = Spacing.s2))
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
 * is shown, and approving appends its keys to the directory. A request to approve needs the
 * owner, so it carries the beacon. [otherWays] adds other ways to pair under the code field.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PairCard(approval: Approval, actions: DeviceActions, otherWays: @Composable ColumnScope.() -> Unit = {}) {
    val colors = StarbridgeTheme.colors
    var code by rememberSaveable { mutableStateOf("") }
    Panel(Modifier.fillMaxWidth()) {
        AnimatedContent(approval, contentKey = { it::class }, label = "pairing") { state ->
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
                when (state) {
                    is Approval.Found, is Approval.Approving -> {
                        val f = state as? Approval.Found ?: (state as Approval.Approving).found
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Beacon()
                            Spacer(Modifier.width(Spacing.s2))
                            Label("Wants to join", color = colors.fg)
                        }
                        Text(f.name, style = StarbridgeTheme.type.question, color = colors.fg)
                        Text(
                            if (f.kind == Kind.Machine) "A machine: its agents can ask you decisions and send quotas." else "A device: it can read and answer decisions.",
                            style = StarbridgeTheme.type.body,
                            color = colors.fg2,
                        )
                        Text(f.code, style = StarbridgeTheme.type.machine, color = colors.fg2)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Button(
                                onClick = actions.approve,
                                enabled = state is Approval.Found,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = colors.accent,
                                    contentColor = colors.onAccent,
                                    disabledContainerColor = colors.accent,
                                    disabledContentColor = colors.onAccent,
                                ),
                                modifier = Modifier.weight(1f).heightIn(min = Sizes.tap),
                            ) {
                                if (state is Approval.Approving) LoadingIndicator(Modifier.size(Spacing.s6), color = colors.onAccent)
                                else Text("Approve", style = StarbridgeTheme.type.action)
                            }
                            Spacer(Modifier.width(Spacing.s2))
                            OutlinedButton(onClick = { actions.close(); code = "" }, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Cancel", style = StarbridgeTheme.type.action) }
                        }
                    }
                    is Approval.Done -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = colors.ok)
                            Spacer(Modifier.width(Spacing.s2))
                            Text("${state.name} joined.", style = StarbridgeTheme.type.body, color = colors.fg)
                        }
                        OutlinedButton(onClick = { actions.close(); code = "" }, modifier = Modifier.heightIn(min = Sizes.tap)) { Text("Pair another", style = StarbridgeTheme.type.action) }
                    }
                    else -> {
                        Text("Add a machine or device", style = StarbridgeTheme.type.heading, color = colors.fg)
                        Text("Type the code it shows: starbridge pair on a machine, or Join on a new phone or browser.", style = StarbridgeTheme.type.small, color = colors.fg2)
                        TextField(
                            value = code,
                            onValueChange = { code = it.take(40) },
                            label = { Text("Pairing code") },
                            placeholder = { Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX") },
                            singleLine = true,
                            textStyle = StarbridgeTheme.type.machine,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { actions.lookUp(code) }),
                            colors = fieldColors(),
                            modifier = Modifier.fillMaxWidth(),
                            isError = state is Approval.Failed,
                            supportingText = (state as? Approval.Failed)?.let { { Text(it.message) } },
                        )
                        Button(
                            onClick = { actions.lookUp(code) },
                            enabled = code.isNotBlank() && state != Approval.Checking,
                            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
                        ) {
                            if (state == Approval.Checking) LoadingIndicator(Modifier.size(Spacing.s6), color = colors.fg2)
                            else Text("Check code", style = StarbridgeTheme.type.action)
                        }
                        // Other ways to add a device (a 6-digit check, a QR code: #66) go here.
                        otherWays()
                    }
                }
            }
        }
    }
}

/** One row of a grouped list: [content] on `surface` in its group's [shape]. */
@Composable
private fun GroupRow(shape: Shape, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = shape, color = StarbridgeTheme.colors.surface) {
        Column(Modifier.padding(horizontal = Spacing.s5, vertical = Spacing.s4), content = content)
    }
}

@Composable
private fun MemberRow(member: Member, now: Instant, shape: Shape, onRevoke: () -> Unit) {
    val colors = StarbridgeTheme.colors
    GroupRow(shape) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (member.kind == Kind.Machine) Icons.Rounded.Computer else Icons.Rounded.Smartphone, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(Spacing.s6))
            Spacer(Modifier.width(Spacing.s4))
            Column(Modifier.weight(1f)) {
                Text(member.name, style = if (member.kind == Kind.Machine) StarbridgeTheme.type.machine.copy(fontSize = StarbridgeTheme.type.body.fontSize) else StarbridgeTheme.type.body, color = colors.fg)
                Text(if (member.current) "This phone" else "Added ${ago(now, member.addedAt)}", style = StarbridgeTheme.type.small, color = colors.fg2)
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

/** How pushes arrive on this phone. */
@Composable
private fun Notifications(push: PushSetting, onPush: (String) -> Unit, shape: Shape) {
    val colors = StarbridgeTheme.colors
    GroupRow(shape) {
        Text("Notifications through", style = StarbridgeTheme.type.body, color = colors.fg)
        Spacer(Modifier.padding(top = Spacing.s3))
        Choice(listOf("fcm" to "Google", "unifiedpush" to "UnifiedPush"), push.type, onPush, Modifier.fillMaxWidth())
        Spacer(Modifier.padding(top = Spacing.s3))
        val (status, color) = when {
            push.registered -> "Registered with your server" to colors.ok
            push.type == "unifiedpush" && push.distributors.isEmpty() -> "Install a UnifiedPush distributor, such as ntfy, then pick UnifiedPush again" to colors.warn
            push.type == "fcm" && !push.fcmAvailable -> "This build has no Firebase project; pick UnifiedPush" to colors.warn
            else -> "Not registered yet" to colors.warn
        }
        StatusWord(status, color)
    }
}

/** The "Colours" setting: DESIGN.md's palette, or Material You; amber and the quota colours stay. */
@Composable
private fun ColoursSetting(colours: Colours, onColours: (Colours) -> Unit, shape: Shape) {
    val colors = StarbridgeTheme.colors
    GroupRow(shape) {
        Text("Colours", style = StarbridgeTheme.type.body, color = colors.fg)
        Spacer(Modifier.padding(top = Spacing.s3))
        Choice(listOf(Colours.Starbridge to "Starbridge", Colours.Wallpaper to "Match wallpaper"), colours, onColours, Modifier.fillMaxWidth())
        Spacer(Modifier.padding(top = Spacing.s3))
        Text("Amber and the quota colours stay the same under both.", style = StarbridgeTheme.type.small, color = colors.fg2)
    }
}

/** The server this phone uses, and signing out. */
@Composable
private fun Account(server: String, shape: Shape, onSignOut: () -> Unit) {
    val colors = StarbridgeTheme.colors
    GroupRow(shape) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Server", style = StarbridgeTheme.type.body, color = colors.fg)
                Text(server, style = StarbridgeTheme.type.machine, color = colors.fg2)
            }
            TextButton(onClick = onSignOut, colors = ButtonDefaults.textButtonColors(contentColor = colors.bad), modifier = Modifier.heightIn(min = Sizes.tap)) {
                Text("Sign out", style = StarbridgeTheme.type.action)
            }
        }
    }
}

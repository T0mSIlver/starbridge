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
import androidx.compose.material3.MaterialTheme
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
import dev.starbridge.app.ui.pairing.QrWays
import dev.starbridge.app.ui.pairing.rememberScanner
import dev.starbridge.app.ui.day
import dev.starbridge.app.ui.pairing.ShowingQr
import dev.starbridge.app.ui.listPadding
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant
import javax.inject.Inject
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Page
import androidx.compose.ui.unit.dp
import androidx.compose.material3.FilledTonalButton
import androidx.compose.foundation.layout.height

@HiltViewModel
class DevicesViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val members = store.members
    val approval = store.approval
    val actions = DeviceActions(store::lookUpPairing, store::approvePairing, store::closePairing, store::revoke, store::showCode)
}

class DeviceActions(
    val lookUp: (String) -> Unit,
    val approve: () -> Unit,
    val close: () -> Unit,
    val revoke: (String) -> Unit,
    /** Shows a QR code for a new phone to scan. */
    val showCode: () -> Unit,
)

/** The account's devices and machines, each with Revoke; adding one opens its own page. */
@Composable
fun DevicesScreen(
    members: List<Member>,
    now: Instant,
    actions: DeviceActions,
    modifier: Modifier = Modifier,
    onBack: () -> Unit = {},
    onAdd: () -> Unit = {},
    /** A pairing code read by the scanner; a phone that cannot scan opens Add a device instead. */
    onScan: (String) -> Unit = {},
) {
    val scan = rememberScanner(onResult = onScan, onError = { onAdd() })
    // Devices first, then machines, each in the order the directory added them.
    val rows = members.sortedBy { it.kind != Kind.Device }
    var revoking by rememberSaveable { mutableStateOf<String?>(null) }
    Page("Devices", modifier, onBack = onBack, titleGap = Spacing.s4) {
        itemsIndexed(rows, key = { _, it -> it.id }) { i, it -> MemberRow(it, now, groupShape(i, rows.size, outer = Spacing.s5)) { revoking = it.id } }
        item {
            FilledTonalButton(
                onClick = scan,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface),
                modifier = Modifier.fillMaxWidth().padding(start = Spacing.s1, end = Spacing.s1, top = Spacing.s4 - groupGap).height(Sizes.tap),
            ) {
                Symbol(Sym.Qr, size = 20.dp)
                Spacer(Modifier.width(Spacing.s2))
                Text("Scan a QR code", style = StarbridgeTheme.type.action)
            }
        }
        item {
            FilledTonalButton(
                onClick = onAdd,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface),
                modifier = Modifier.fillMaxWidth().padding(start = Spacing.s1, end = Spacing.s1, top = Spacing.s2, bottom = Spacing.s4 - groupGap).height(Sizes.tap),
            ) {
                Text("Other ways to add a device", style = StarbridgeTheme.type.action)
            }
        }
    }
    revoking?.let { id ->
        val name = members.find { it.id == id }?.name ?: id
        Confirm(
            title = "Revoke $name?",
            text = "It can no longer read or answer anything. This can't be undone.",
            action = "Revoke",
            onConfirm = { actions.revoke(id); revoking = null },
            onDismiss = { revoking = null },
        )
    }
}

/** Adding a machine or device: its code, or a QR code for a new phone. */
@Composable
fun AddDeviceScreen(
    approval: Approval,
    actions: DeviceActions,
    modifier: Modifier = Modifier,
    onBack: () -> Unit = {},
    otherWaysToPair: @Composable ColumnScope.() -> Unit = { QrWays(onScan = actions.lookUp, onShow = actions.showCode) },
) {
    Page("Add a device", modifier, onBack = onBack, titleGap = Spacing.s4) {
        item { PairCard(approval, actions, otherWaysToPair) }
    }
}

@Composable
fun Confirm(title: String, text: String, action: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
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
                            Label("Wants to join", color = MaterialTheme.colorScheme.onSurface)
                        }
                        Text(f.name, style = StarbridgeTheme.type.question, color = MaterialTheme.colorScheme.onSurface)
                        Text(
                            if (f.kind == Kind.Machine) "A machine: its agents can ask you decisions and send quotas." else "A device: it can read and answer decisions.",
                            style = StarbridgeTheme.type.body,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(f.code, style = StarbridgeTheme.type.machine, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                    is Approval.Showing -> ShowingQr(state) { actions.close(); code = "" }
                    else -> {
                        // A pairing that just ended says so above the ways to pair the next one.
                        if (state is Approval.Done) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = colors.ok)
                                Spacer(Modifier.width(Spacing.s2))
                                Text("${state.name} joined.", style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        Text("Add a machine or device", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface)
                        otherWays()
                        Text("Or type the code it shows: starbridge pair on a machine, or Join on a new phone or browser.", style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                        OutlinedButton(
                            onClick = { actions.lookUp(code) },
                            enabled = code.isNotBlank() && state != Approval.Checking,
                            modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
                        ) {
                            if (state == Approval.Checking) LoadingIndicator(Modifier.size(Spacing.s6), color = MaterialTheme.colorScheme.secondary)
                            else Text("Check code", style = StarbridgeTheme.type.action)
                        }
                    }
                }
            }
        }
    }
}

/** A member: its kind's icon, name and when it joined; Revoke is a neutral text button. */
@Composable
private fun MemberRow(member: Member, now: Instant, shape: Shape, onRevoke: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), shape = shape, color = scheme.surfaceContainer) {
        Row(Modifier.padding(Spacing.s4), verticalAlignment = Alignment.CenterVertically) {
            Symbol(if (member.kind == Kind.Machine) Sym.Computer else Sym.Phone, tint = scheme.onSurface)
            Spacer(Modifier.width(Spacing.s4))
            Column(Modifier.weight(1f)) {
                Text(member.name, style = StarbridgeTheme.type.body, color = scheme.onSurface)
                val added = "added ${day(member.addedAt)}"
                Text(
                    when {
                        member.current -> "This phone"
                        member.kind == Kind.Machine -> "Machine · $added"
                        else -> added.replaceFirstChar { it.uppercase() }
                    },
                    style = StarbridgeTheme.type.small,
                    color = scheme.onSurfaceVariant,
                )
            }
            if (!member.current) {
                TextButton(onClick = onRevoke, colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSurface)) {
                    Text("Revoke", style = StarbridgeTheme.type.label)
                }
            }
        }
    }
}



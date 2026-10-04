package dev.starbridge.app.ui.devices

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.Pairing
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
class DevicesViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val members = store.members
    val pairings = store.pairings
    fun approve(id: String) = store.approve(id)
    fun deny(id: String) = store.deny(id)
    fun revoke(id: String) = store.revoke(id)
}

class DeviceActions(val approve: (String) -> Unit, val deny: (String) -> Unit, val revoke: (String) -> Unit)

/** Pairing requests on top, then the devices that read decisions and the machines that post them. */
@Composable
fun DevicesScreen(members: List<Member>, pairings: List<Pairing>, now: Instant, actions: DeviceActions, modifier: Modifier = Modifier) {
    val devices = members.filter { it.kind != Kind.Machine }
    val machines = members.filter { it.kind == Kind.Machine }
    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        item { Title("Devices and machines") }
        items(pairings, key = { it.id }) { PairingCard(it, now, actions) }
        item { Label("Devices", Modifier.padding(top = Spacing.s2)) }
        items(devices, key = { it.id }) { MemberRow(it, now, actions.revoke) }
        item { Label("Machines", Modifier.padding(top = Spacing.s2)) }
        items(machines, key = { it.id }) { MemberRow(it, now, actions.revoke) }
        item {
            Text(
                "The recovery key was shown once, when you set up your first device. It can approve a new device if you lose all of them.",
                style = StarbridgeTheme.type.small,
                color = StarbridgeTheme.colors.fg3,
                modifier = Modifier.padding(top = Spacing.s4),
            )
        }
    }
}

@Composable
private fun PairingCard(pairing: Pairing, now: Instant, actions: DeviceActions) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth(), border = colors.accent) {
        Label("Wants to join · ${ago(now, pairing.requestedAt)}", color = colors.accent)
        Spacer(Modifier.padding(top = Spacing.s2))
        Text(pairing.machine, style = StarbridgeTheme.type.question, color = colors.fg)
        Spacer(Modifier.padding(top = Spacing.s1))
        Text("Approve only if its terminal shows this code:", style = StarbridgeTheme.type.body, color = colors.fg2)
        Text(pairing.code, style = StarbridgeTheme.type.figure, color = colors.fg, modifier = Modifier.padding(vertical = Spacing.s3))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = { actions.approve(pairing.id) },
                shape = RoundedCornerShape(Radius.pill),
                modifier = Modifier.weight(1f).heightIn(min = Sizes.tap),
            ) { Text("Approve", style = StarbridgeTheme.type.action) }
            Spacer(Modifier.padding(start = Spacing.s2))
            TextButton(
                onClick = { actions.deny(pairing.id) },
                modifier = Modifier.heightIn(min = Sizes.tap),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) { Text("Deny", style = StarbridgeTheme.type.action) }
        }
    }
}

@Composable
private fun MemberRow(member: Member, now: Instant, onRevoke: (String) -> Unit) {
    val colors = StarbridgeTheme.colors
    Panel(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val icon = when (member.kind) {
                Kind.Phone -> Icons.Rounded.PhoneAndroid
                Kind.Browser -> Icons.Rounded.Language
                Kind.Machine -> Icons.Rounded.Computer
            }
            Icon(icon, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(Spacing.s6))
            Spacer(Modifier.padding(start = Spacing.s3))
            Column(Modifier.weight(1f)) {
                Text(member.name, style = if (member.kind == Kind.Machine) StarbridgeTheme.type.machine else StarbridgeTheme.type.body, color = colors.fg)
                Text(if (member.current) "This device" else "Added ${ago(now, member.addedAt)}", style = StarbridgeTheme.type.small, color = colors.fg3)
            }
            if (!member.current) {
                TextButton(
                    onClick = { onRevoke(member.id) },
                    modifier = Modifier.heightIn(min = Sizes.tap),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.bad),
                ) { Text("Revoke", style = StarbridgeTheme.type.action) }
            }
        }
    }
}

package dev.starbridge.app.ui.settings

import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.ToggleButton
import androidx.compose.material3.ToggleButtonDefaults
import androidx.compose.material3.ToggleButtonShapes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntOffset
import dev.starbridge.app.ui.groupGap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.CardButtons
import dev.starbridge.app.data.Clock
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.InboxView
import dev.starbridge.app.data.openLink
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Section
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.openNotificationSettings
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.devices.Confirm
import dev.starbridge.app.ui.rowShape
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(private val store: Store, private val prefs: Prefs) : ViewModel() {
    val windows = store.windows
    val quota = prefs.quota
    val members = store.members
    val push = store.push
    val server = store.server
    val colours = prefs.colours
    val inbox = prefs.inbox
    fun setInbox(value: InboxView) = prefs.setInbox(value)
    val allowUnseen = prefs.allowUnseen
    fun setAllowUnseen(value: Boolean) = prefs.setAllowUnseen(value)
    fun setQuota(value: QuotaSettings) = prefs.setQuota(value)
    fun setColours(value: Colours) = prefs.setColours(value)
    val clock = prefs.clock
    fun setClock(value: Clock) = prefs.setClock(value)
    fun setPush(type: String) = store.setPushType(type)
    fun signOut() = store.signOut()
}

/** What the settings page changes, and where its rows lead. */
class SettingsActions(
    val quota: (QuotaSettings) -> Unit,
    val colours: (Colours) -> Unit,
    val push: (String) -> Unit,
    val signOut: () -> Unit,
    val devices: () -> Unit,
    val addDevice: () -> Unit,
    val inbox: (InboxView) -> Unit = {},
    val clock: (Clock) -> Unit = {},
    val allowUnseen: (Boolean) -> Unit = {},
)

/** Everything this phone keeps for itself, and the account's devices. The settings stay on the phone. */
@Composable
fun SettingsScreen(
    windows: List<QuotaWindow>,
    quota: QuotaSettings,
    members: Int,
    colours: Colours,
    push: PushSetting,
    server: String,
    actions: SettingsActions,
    modifier: Modifier = Modifier,
    inbox: InboxView = InboxView(),
    clock: Clock = Clock.System,
    allowUnseen: Boolean = false,
    notificationsOff: Boolean = false,
) {
    val context = LocalContext.current
    var signingOut by rememberSaveable { mutableStateOf(false) }
    val set = actions.quota
    Page("Settings", modifier, titleGap = Spacing.s2) {
        item { Section("Quota windows") }
        val quotaRows = 6
        item {
            ChoiceRow(0, quotaRows, "Bar shows") { Segments(listOf(true to "Used", false to "Left"), quota.showUsed) { set(quota.copy(showUsed = it)) } }
        }
        item {
            ChoiceRow(1, quotaRows, "Reset times") { Segments(listOf(false to "Resets in 2 h", true to "Resets 14:20"), quota.absoluteResets) { set(quota.copy(absoluteResets = it)) } }
        }
        item {
            ChoiceRow(2, quotaRows, "Workday ticks on weekly bars") {
                Segments(listOf(null to "Off", 4 to "4", 5 to "5", 7 to "7 days"), quota.workDays) { set(quota.copy(workDays = it)) }
            }
        }
        item { SwitchRow(3, quotaRows, "Running out first", quota.runningOutFirst) { set(quota.copy(runningOutFirst = it)) } }
        item { SwitchRow(4, quotaRows, "Warn before a window runs out", quota.notifyPace) { set(quota.copy(notifyPace = it)) } }
        item { SwitchRow(5, quotaRows, "Warn at 50% and 20% left", quota.notifyLow) { set(quota.copy(notifyLow = it)) } }

        val providers = quota.providers(windows)
        if (providers.isNotEmpty()) {
            item { Section("Providers") }
            itemsIndexed(providers, key = { _, p -> "provider/$p" }) { i, p ->
                val labels = windows.filter { it.provider == p }.map { it.window }.distinct().joinToString(", ")
                ProviderRow(
                    p,
                    labels,
                    shown = p !in quota.hidden,
                    notify = p in quota.notify,
                    shape = rowShape(i, providers.size),
                    onShow = { on -> set(quota.copy(hidden = if (on) quota.hidden - p else (quota.hidden + p).distinct())) },
                    onNotify = { on -> set(quota.copy(notify = if (on) (quota.notify + p).distinct() else quota.notify - p)) },
                    first = i == 0,
                    last = i == providers.lastIndex,
                    onMove = { by ->
                        val to = (i + by).coerceIn(0, providers.lastIndex)
                        if (to != i) set(quota.copy(order = providers.toMutableList().apply { add(to, removeAt(i)) }))
                    },
                    // The row under the finger follows it, not the placement animation.
                    placement = { dragging -> Modifier.animateItem(placementSpec = if (dragging) null else spring(stiffness = Spring.StiffnessMediumLow, visibilityThreshold = IntOffset.VisibilityThreshold)) },
                )
            }
        }

        item { Section("Answer buttons on cards") }
        listOf(CardButtons.Always to "Always", CardButtons.WhenWaiting to "When the agent waits", CardButtons.Never to "Never").forEachIndexed { i, (value, label) ->
            item { RadioRow(i, 3, label, inbox.buttons == value) { actions.inbox(inbox.copy(buttons = value)) } }
        }

        item { Section("Devices") }
        item { LinkRow(0, 2, "Devices and machines", "$members", Sym.Chevron, actions.devices) }
        item { LinkRow(1, 2, "Add a device", null, Sym.Qr, actions.addDevice) }

        item { Section("Colours") }
        item { RadioRow(0, 2, "Starbridge", colours == Colours.Starbridge) { actions.colours(Colours.Starbridge) } }
        item { RadioRow(1, 2, "Match wallpaper", colours == Colours.Wallpaper) { actions.colours(Colours.Wallpaper) } }

        item { Section("Clock") }
        item {
            ChoiceRow(0, 1, "Time format") {
                Segments(listOf(Clock.System to "System", Clock.H12 to "12-hour", Clock.H24 to "24-hour"), clock, actions.clock)
            }
        }

        item { Section("Notifications") }
        item {
            LinkRow(
                0, 4,
                if (notificationsOff) "Notifications are off" else "Notification settings",
                if (notificationsOff) "Questions only show in the app. Turn notifications on in Android's settings." else null,
                Sym.Chevron,
            ) { openNotificationSettings(context) }
        }
        item { SwitchRow(1, 4, "Remind me when notifications are off", inbox.remindOff) { actions.inbox(inbox.copy(remindOff = it)) } }
        item {
            ChoiceRow(2, 4, "Delivered through", push(push)) {
                Segments(listOf("fcm" to "Google", "unifiedpush" to "UnifiedPush"), push.type, actions.push)
            }
        }
        item {
            SwitchRow(
                3, 4, "Allow from notifications without seeing the whole command", allowUnseen,
                sub = "Unsafe: you may approve commands you haven't read. Off, Allow opens the whole command first.",
                onChange = actions.allowUnseen,
            )
        }

        item { Section("Agents") }
        item { LinkRow(0, 1, "How to tell your agents", null, Sym.Open) { openLink(context, GUIDE) } }

        item { Section("Account") }
        item { LinkRow(0, 2, "Server", server, null) {} }
        item { LinkRow(1, 2, "Sign out", null, Sym.Logout) { signingOut = true } }
    }
    if (signingOut) {
        Confirm(
            title = "Sign out?",
            text = "This phone forgets its keys and leaves your devices. If it is your only device, you need the recovery key to set up another.",
            action = "Sign out",
            onConfirm = { actions.signOut(); signingOut = false },
            onDismiss = { signingOut = false },
        )
    }
}

private const val GUIDE = "https://starbridge.run/docs/tell-your-agents"

/** How pushes reach this phone, as a state. */
private fun push(push: PushSetting) = when {
    push.registered -> "Registered with your server"
    push.type == "unifiedpush" && push.distributors.isEmpty() -> "No UnifiedPush distributor installed"
    push.type == "fcm" && !push.fcmAvailable -> "This build has no Firebase project"
    else -> "Not registered yet"
}

/** A settings row on `surface`: its name, an optional state under it, and its control. */
@Composable
private fun Shell(index: Int, count: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = rowShape(index, count), color = MaterialTheme.colorScheme.surfaceContainer) { content() }
}

@Composable
private fun Texts(title: String, sub: String?, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(title, style = StarbridgeTheme.type.body, color = MaterialTheme.colorScheme.onSurface)
        sub?.let { Text(it, style = StarbridgeTheme.type.small, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A row whose control sits under its name: a connected group of choices. */
@Composable
private fun ChoiceRow(index: Int, count: Int, title: String, sub: String? = null, control: @Composable () -> Unit) {
    Shell(index, count) {
        Column(Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s3)) {
            Texts(title, sub)
            control()
        }
    }
}

@Composable
private fun SwitchRow(index: Int, count: Int, title: String, checked: Boolean, sub: String? = null, onChange: (Boolean) -> Unit) {
    Shell(index, count, Modifier.toggleable(checked, role = Role.Switch, onValueChange = onChange)) {
        Line { Texts(title, sub, Modifier.weight(1f)); Switch(checked = checked, onCheckedChange = null) }
    }
}

@Composable
private fun RadioRow(index: Int, count: Int, title: String, selected: Boolean, onSelect: () -> Unit) {
    Shell(index, count, Modifier.selectable(selected, role = Role.RadioButton, onClick = onSelect)) {
        Line { Texts(title, null, Modifier.weight(1f)); RadioButton(selected = selected, onClick = null) }
    }
}

@Composable
private fun LinkRow(index: Int, count: Int, title: String, sub: String?, icon: Sym?, onClick: () -> Unit) {
    Shell(index, count, if (icon != null) Modifier.clickable(onClick = onClick) else Modifier) {
        Line {
            Texts(title, sub, Modifier.weight(1f))
            icon?.let { Symbol(it, size = 20.dp, tint = MaterialTheme.colorScheme.onSurface) }
        }
    }
}

@Composable
private fun Line(content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(Spacing.s4),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s4),
        content = content,
    )
}

/**
 * A provider: its windows, a handle to drag it up or down (long press), a bell for its quota
 * notifications, and whether it shows.
 * Screen readers get "Move up" and "Move down" instead of the drag.
 */
@Composable
private fun ProviderRow(
    name: String,
    sub: String,
    shown: Boolean,
    notify: Boolean,
    shape: Shape,
    first: Boolean,
    last: Boolean,
    onShow: (Boolean) -> Unit,
    onNotify: (Boolean) -> Unit,
    onMove: (Int) -> Unit,
    placement: (dragging: Boolean) -> Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    var offset by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    var height by remember { mutableIntStateOf(0) }
    val move by rememberUpdatedState(onMove)
    val ends by rememberUpdatedState(first to last)
    Surface(
        placement(dragging)
            .fillMaxWidth()
            .onSizeChanged { height = it.height }
            .zIndex(if (dragging) 1f else 0f)
            .graphicsLayer { translationY = offset }
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction("Move up") { onMove(-1); true },
                    CustomAccessibilityAction("Move down") { onMove(1); true },
                )
            },
        shape = shape,
        color = if (dragging) scheme.surfaceContainerHigh else scheme.surfaceContainer,
        shadowElevation = if (dragging) 3.dp else 0.dp,
    ) {
        Line {
            Texts(name, sub, Modifier.weight(1f))
            Symbol(
                Sym.Drag,
                size = 20.dp,
                tint = StarbridgeTheme.colors.fg3,
                modifier = Modifier.pointerInput(Unit) {
                    detectDragGesturesAfterLongPress(
                        onDragStart = { dragging = true },
                        onDragEnd = { dragging = false; offset = 0f },
                        onDragCancel = { dragging = false; offset = 0f },
                    ) { change, drag ->
                        change.consume()
                        // A row and its 2 dp gap; past half of it, the provider swaps with its neighbour.
                        val step = height + groupGap.toPx()
                        val (top, bottom) = ends
                        offset = (offset + drag.y).coerceIn(if (top) 0f else -step, if (bottom) 0f else step)
                        if (offset > step / 2 && !bottom) { move(1); offset -= step }
                        if (offset < -step / 2 && !top) { move(-1); offset += step }
                    }
                },
            )
            IconToggleButton(checked = notify, onCheckedChange = onNotify, enabled = shown) {
                Symbol(Sym.Bell, size = 20.dp, filled = notify, tint = if (notify) scheme.onSurface else StarbridgeTheme.colors.fg3, contentDescription = "Notify about $name")
            }
            Switch(checked = shown, onCheckedChange = onShow)
        }
    }
}

/**
 * Connected choices (Material 3 Expressive's button group), each as wide as its label: the picked
 * one filled in `fg`, the others on the highest container. When the labels don't fit side by side,
 * the choices stack, each the full width.
 */
@Composable
fun <T> Segments(choices: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    SubcomposeLayout { c ->
        val row = subcompose("row") { SegmentButtons(choices, selected, onSelect, stacked = false) }.first()
        val fits = row.maxIntrinsicWidth(c.maxHeight) <= c.maxWidth
        val shown = if (fits) row else subcompose("stack") { SegmentButtons(choices, selected, onSelect, stacked = true) }.first()
        val placeable = shown.measure(c.copy(minWidth = 0, minHeight = 0))
        layout(maxOf(placeable.width, c.minWidth), maxOf(placeable.height, c.minHeight)) { placeable.place(0, 0) }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun <T> SegmentButtons(choices: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, stacked: Boolean) {
    val buttons = @Composable {
        choices.forEachIndexed { i, (value, label) ->
            ToggleButton(
                checked = value == selected,
                onCheckedChange = { onSelect(value) },
                modifier = Modifier.height(40.dp).then(if (stacked) Modifier.fillMaxWidth() else Modifier).semantics { role = Role.RadioButton },
                shapes = when {
                    stacked -> ToggleButtonShapes(ToggleButtonDefaults.shape, ToggleButtonDefaults.pressedShape, ToggleButtonDefaults.checkedShape)
                    i == 0 -> ButtonGroupDefaults.connectedLeadingButtonShapes()
                    i == choices.lastIndex -> ButtonGroupDefaults.connectedTrailingButtonShapes()
                    else -> ButtonGroupDefaults.connectedMiddleButtonShapes()
                },
                colors = ToggleButtonDefaults.colors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                    checkedContainerColor = MaterialTheme.colorScheme.primary,
                    checkedContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                contentPadding = PaddingValues(horizontal = 14.dp),
            ) { Text(label, style = StarbridgeTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
    // Stacked 40 dp choices sit 8 dp apart, so each keeps a 48 dp tap area.
    if (stacked) Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) { buttons() } else Row(horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween)) { buttons() }
}

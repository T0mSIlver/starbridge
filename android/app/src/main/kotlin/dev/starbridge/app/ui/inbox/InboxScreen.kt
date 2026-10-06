package dev.starbridge.app.ui.inbox

import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.day
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.data.RecoveryUi
import androidx.compose.animation.animateColorAsState
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.TextStyle
import dev.starbridge.app.data.Grouping
import dev.starbridge.app.ui.SheetBody
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.CardButtons
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.InboxView
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.Store
import dev.starbridge.app.data.openLink
import dev.starbridge.app.data.place
import dev.starbridge.app.ui.Lockup
import dev.starbridge.app.ui.Page
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.openNotificationSettings
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.fieldColors
import dev.starbridge.app.ui.groupGap
import dev.starbridge.app.ui.groupShape
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import javax.inject.Inject
import androidx.compose.animation.core.tween
import androidx.compose.ui.zIndex
import androidx.compose.ui.draw.clip
import android.content.ClipData
import android.content.Intent
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import android.os.Build
import android.widget.Toast

@HiltViewModel
class InboxViewModel @Inject constructor(private val store: Store, private val prefs: Prefs) : ViewModel() {
    val decisions = store.decisions
    val sending = store.sending
    val prompts = store.prompts
    val runs = store.runs
    val view = prefs.inbox
    fun setView(value: InboxView) = prefs.setInbox(value)
    fun answerPrompt(id: String, allow: Boolean, scope: String, message: String?) = store.answerPrompt(id, allow, scope, message)
    fun refreshPrompts() = store.refreshPrompts()
    fun answer(id: String, choice: String?, text: String?) = store.answer(id, choice, text)
    fun snooze(id: String, until: Instant) = store.snooze(id, until)
    fun refresh() = store.refresh()
    val recovery = store.recovery
    val members = store.members
    fun dismissRecovery(seq: Int) = store.dismissRecoveryNotice(seq)
}

/** What a question can do: be answered with an option or text, or open in its sheet. */
class DecisionActions(
    val answer: (id: String, choice: String?, text: String?) -> Unit,
    val open: (String) -> Unit,
    /** Puts a question off until a time (#571); a time already passed brings it back. */
    val snooze: (id: String, until: Instant) -> Unit = { _, _ -> },
)

/**
 * What a question's card and its sheet share while the owner answers: the reply drafts, by
 * decision id, and the answers going out, which lock the question until the server replies.
 */
class Replies(val drafts: SnapshotStateMap<String, String>, val sending: Map<String, String>)

/** Reply drafts that survive rotation and process death; one map serves the card and the sheet. */
@Composable
fun rememberDrafts(): SnapshotStateMap<String, String> = rememberSaveable(
    saver = listSaver(
        save = { it.flatMap { (id, text) -> listOf(id, text) } },
        restore = { saved -> mutableStateMapOf<String, String>().apply { saved.chunked(2).forEach { (id, text) -> put(id, text) } } },
    ),
) { mutableStateMapOf() }

/** One card of the feed. */
private sealed interface Item {
    val machine: Source
    val key: String

    /** Whether an agent waits on it: a prompt, or a question its agent marked waiting. */
    val blocks: Boolean

    class RunItem(val run: Run) : Item {
        override val machine get() = run.source
        override val key get() = "run/${run.id}"
        override val blocks get() = false
    }

    class PromptItem(val prompt: Prompt) : Item {
        override val machine get() = prompt.source
        override val key get() = "p/${prompt.id}"
        override val blocks get() = true
    }

    class Question(val decision: Decision) : Item {
        override val machine get() = decision.source
        override val key get() = "d/${decision.id}"
        override val blocks get() = decision.waiting
    }
}

/**
 * One feed: runs, then permission prompts, then questions, the ones an agent waits on first.
 * "Group by machine" splits the same feed under each machine; "Group by waiting" puts what
 * blocks an agent under "Waiting on you" and the rest under "When you can", runs above both.
 * History holds what was answered.
 */
@Composable
fun InboxScreen(
    decisions: List<Decision>,
    now: Instant,
    actions: DecisionActions,
    modifier: Modifier = Modifier,
    refresh: Refresh? = null,
    replies: Replies = Replies(rememberDrafts(), emptyMap()),
    prompts: List<Prompt> = emptyList(),
    promptActions: PromptActions? = null,
    pollPrompts: () -> Unit = {},
    runs: List<Run> = emptyList(),
    view: InboxView = InboxView(),
    onView: (InboxView) -> Unit = {},
    onFind: () -> Unit = {},
    /** A replacement of the recovery key made on another device (#348), and how to dismiss it. */
    recovery: RecoveryUi? = null,
    dismissRecovery: (Int) -> Unit = {},
    notificationsOff: Boolean = false,
    /** The account has no active machine yet: the empty inbox says how to add one (#610). */
    noMachine: Boolean = false,
) {
    // While a prompt is on screen, read prompts every 1.5 s, so one settled elsewhere leaves
    // at once; the clock ticks with it for the 3 s a closed prompt stays.
    var tick by remember { mutableStateOf(now) }
    val at = if (tick.isAfter(now)) tick else now
    val shown = if (promptActions == null) emptyList() else shownPrompts(prompts, at)
    val polling = shown.isNotEmpty()
    // Only while the app is in front: in the background the poll would run on unseen.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(polling, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (polling) {
                delay(PROMPT_POLL_MS)
                tick = Instant.now()
                pollPrompts()
            }
        }
    }
    val shownRuns = Run.shown(runs, now)
    val open = openQuestions(decisions).filterNot { it.snoozed(now) }
    val snoozed = decisions.filter { it.snoozed(now) }.sortedBy { it.snoozedUntil }
    val runItems = shownRuns.map(Item::RunItem)
    val needs: List<Item> = shown.map(Item::PromptItem) + open.map(Item::Question)
    val feed: List<Item> = runItems + needs
    val needYou = open.size + shown.count { it.waiting(at) }
    val running = shownRuns.count { it.state(now) == Run.State.Running }
    val history = History(decisions.filterNot { it.isOpen }, prompts.filter { !it.waiting(at) && it !in shown }, now)

    Page(
        "Inbox",
        modifier,
        refresh = refresh,
        subtitle = if (feed.isEmpty()) null else ({ NeedsYou(needYou, running) }),
        trailing = {
            IconButton(onClick = onFind) { Symbol(Sym.Search, size = 22.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant, contentDescription = "Find") }
            ViewMenu(view, onView)
        },
        header = { Lockup(24.dp, 22.sp) },
        gap = groupGap,
        margin = Spacing.s4,
        // Closed, History and Snoozed above it wait at the bottom, out of the way; opened, each
        // rises under the items (#662, #682).
        atBottom = atBottom(snoozed.isNotEmpty(), view.snoozedOpen, history.rows.isNotEmpty(), view.historyOpen),
    ) {
        recoveryBanner(recovery, dismissRecovery)
        if (notificationsOff && view.remindOff) item(key = "notifications-off") { NotificationsOff { onView(view.copy(remindOff = false)) } }
        if (feed.isEmpty()) {
            item(key = "empty") { if (noMachine) NoMachine() else Empty() }
        } else {
            when (view.grouping) {
                Grouping.Machine -> byMachine(runItems, needs) { it.machine.machine }.forEach { items ->
                    item(key = "machine/${items.first().machine.machine}") { MachineHeader(items.first().machine) }
                    cards(items, at, actions, replies, promptActions, view.buttons, segmented = true)
                }
                Grouping.Waiting -> {
                    val (running, rest) = feed.partition { it is Item.RunItem }
                    val (blocking, later) = rest.partition { it.blocks }
                    cards(running, at, actions, replies, promptActions, view.buttons, segmented = true)
                    if (blocking.isNotEmpty()) {
                        // A prompt settled elsewhere stays a moment in place, but no longer counts.
                        val count = blocking.count { it !is Item.PromptItem || it.prompt.waiting(at) }
                        item(key = "group/waiting") { GroupHeader("Waiting on you", count, StarbridgeTheme.colors.accent) }
                        cards(blocking, at, actions, replies, promptActions, view.buttons, segmented = true)
                    }
                    if (later.isNotEmpty()) {
                        item(key = "group/later") { GroupHeader("When you can", later.size, MaterialTheme.colorScheme.onSurfaceVariant) }
                        cards(later, at, actions, replies, promptActions, view.buttons, segmented = true)
                    }
                }
                Grouping.None -> cards(feed, at, actions, replies, promptActions, view.buttons)
            }
        }
        snoozed(snoozed, now, view.snoozedOpen, { onView(view.copy(snoozedOpen = it)) }, actions, replies, view.buttons, segmented = view.grouping != Grouping.None)
        history(history, view.historyOpen, { onView(view.copy(historyOpen = it)) }, actions, promptActions, segmented = view.grouping != Grouping.None)
    }
}

private const val PROMPT_POLL_MS = 1_500L

/**
 * Notifications are off (#342): a quiet line, since the owner may want them off. "Turn on" opens
 * Android's settings; the ✕ hides the line for good, until Settings' "Remind me" brings it back.
 */
@Composable
private fun NotificationsOff(dismiss: () -> Unit) {
    val context = LocalContext.current
    val dim = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().padding(start = Spacing.s1), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        Symbol(Sym.BellOff, size = 18.dp, tint = dim)
        Text("Notifications are off", style = StarbridgeTheme.type.small, color = dim, modifier = Modifier.weight(1f))
        TextButton(onClick = { openNotificationSettings(context) }) { Text("Turn on") }
        IconButton(onClick = dismiss) { Symbol(Sym.Close, size = 18.dp, tint = dim, contentDescription = "Don't remind me") }
    }
}

/**
 * The inbox's cards (#248), Material 3's filled card with extra-large corners. In One feed each
 * item is its own card, `s2` apart, as Material spaces a collection of cards; under a grouping's
 * header the group's cards join into a segmented group, [groupGap] apart and tight inside.
 */
private val cardShape = RoundedCornerShape(Radius.xl)
private val cardGap = Spacing.s2

private fun segment(index: Int, count: Int) = groupShape(index, count, outer = Radius.xl, inner = Radius.xs)

private fun LazyListScope.cards(items: List<Item>, now: Instant, actions: DecisionActions, replies: Replies, promptActions: PromptActions?, buttons: CardButtons, segmented: Boolean = false) {
    itemsIndexed(items, key = { _, it -> it.key }) { i, item ->
        val shape = if (segmented) segment(i, items.size) else cardShape
        // A question its agent starts or stops waiting on moves with the expressive spring.
        val m = Modifier.animateItem(placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec())
            .padding(top = if (segmented || i == 0) 0.dp else cardGap - groupGap)
        when (item) {
            is Item.RunItem -> RunCard(item.run, now, shape, m)
            is Item.PromptItem -> if (item.prompt.waiting(now) && promptActions != null) PromptCard(item.prompt, now, promptActions, shape, m) else ClosedPrompt(item.prompt, shape, m)
            is Item.Question -> DecisionCard(item.decision, now, actions, replies, shape, buttons, m)
        }
    }
}

/** "4 need you · 1 running", the count in amber. */
@Composable
private fun NeedsYou(count: Int, running: Int) {
    val colors = StarbridgeTheme.colors
    Text(
        buildAnnotatedString {
            if (count > 0) {
                withStyle(SpanStyle(color = colors.accent, fontWeight = FontWeight.SemiBold)) { append("$count") }
                append(" need you")
            } else {
                append("Nothing needs you")
            }
            if (running > 0) append(" · $running running")
        },
        style = StarbridgeTheme.type.body,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** One feed, grouped by machine or by waiting, remembered on this phone. */
@Composable
private fun ViewMenu(view: InboxView, onView: (InboxView) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Symbol(Sym.Filter, size = 22.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant, contentDescription = "View") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(Grouping.None to "One feed", Grouping.Machine to "Group by machine", Grouping.Waiting to "Group by waiting").forEach { (grouping, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    leadingIcon = { if (view.grouping == grouping) Symbol(Sym.Check, size = 20.dp) else Spacer(Modifier.size(20.dp)) },
                    onClick = { open = false; onView(view.copy(grouping = grouping)) },
                    modifier = Modifier.semantics { role = Role.RadioButton },
                )
            }
        }
    }
}

@Composable
private fun MachineHeader(source: Source) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(start = Spacing.s2, top = Spacing.s4 - groupGap, bottom = Spacing.s2 - groupGap), verticalAlignment = Alignment.CenterVertically) {
        Symbol(machineSym(source.machineKind), size = 16.dp, tint = color)
        Spacer(Modifier.width(6.dp))
        Text(source.machine, style = StarbridgeTheme.type.label, color = color)
    }
}

/** "Waiting on you 2": a group's name under "Group by waiting", its count in [countColor]. */
@Composable
internal fun GroupHeader(name: String, count: Int, countColor: Color) {
    val style = StarbridgeTheme.type.label
    Text(
        buildAnnotatedString {
            append(name)
            append("  ")
            withStyle(SpanStyle(color = countColor)) { append("$count") }
        },
        style = style,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Spacing.s2, top = Spacing.s4 - groupGap, bottom = Spacing.s2 - groupGap).semantics { heading() },
    )
}

/** Nothing open: the cookie shape with a check, and History under it. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Empty() {
    Column(Modifier.fillMaxWidth().padding(top = 56.dp, bottom = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
        Box(Modifier.size(160.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Symbol(Sym.Check, size = 56.dp, tint = MaterialTheme.colorScheme.onSurface)
        }
        Text("Nothing needs you", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
    }
}

/** A new account's empty inbox: the install command to copy or send to the machine. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun NoMachine() {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().padding(top = 56.dp, bottom = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
        Box(Modifier.size(160.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Symbol(Sym.Computer, size = 56.dp, tint = MaterialTheme.colorScheme.onSurface)
        }
        Text("Add a machine", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(
            "Install Starbridge on each machine that runs your agents. Its setup shows a code to approve here; then its agents’ questions arrive in this inbox.",
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
            Text(INSTALL, style = StarbridgeTheme.type.code, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(Spacing.s4))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            FilledTonalButton(onClick = {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Install command", INSTALL))) }
                // Android 13 and later confirm a copy themselves.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
            }, modifier = Modifier.heightIn(min = Sizes.tap)) {
                Symbol(Sym.Copy, size = 18.dp)
                Spacer(Modifier.width(Spacing.s2))
                Text("Copy", style = StarbridgeTheme.type.action)
            }
            // To the computer, by mail or a chat, when this phone is not where the terminal is.
            OutlinedButton(
                onClick = { runCatching { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, INSTALL), null)) } },
                modifier = Modifier.heightIn(min = Sizes.tap),
            ) { Text("Send", style = StarbridgeTheme.type.action) }
        }
        TextButton(onClick = { openLink(context, INSTALL_DOCS) }, modifier = Modifier.heightIn(min = Sizes.tap)) {
            Text("Windows, Homebrew and npm", style = StarbridgeTheme.type.action)
        }
    }
}

private const val INSTALL = "curl -fsSL https://starbridge.run/install.sh | sh"
private const val INSTALL_DOCS = "https://starbridge.run/docs"

/**
 * A question in the feed, on the same card as every item (#248): one its agent waits on takes the
 * amber fill, the question at weight 500 and the clock in the time slot; one the agent works
 * around keeps the plain fill and the question at 400. No line of text says which; a screen
 * reader hears it first. Its options show when the Answer
 * buttons setting allows them (#181, as the web's rows).
 */
@Composable
private fun DecisionCard(decision: Decision, now: Instant, actions: DecisionActions, replies: Replies, shape: Shape, buttons: CardButtons, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    // Snoozed, nothing is amber, even when its agent waits: the owner said not now (#571).
    val until = decision.snoozedUntil?.takeIf { decision.snoozed(now) }
    val waiting = decision.waiting && until == null
    val h24 = LocalClock24.current
    val spec = MaterialTheme.motionScheme.fastEffectsSpec<Color>()
    val ground by animateColorAsState(if (waiting) promptGround() else scheme.surfaceContainer, spec)
    val icon by animateColorAsState(if (waiting) StarbridgeTheme.colors.accent else scheme.onSurfaceVariant, spec)
    val label = decision.waitingSince?.takeIf { waiting }?.let { waitingLabel(it, now) }
    val slot = until?.let { "Until ${snoozeTime(it, now, h24)}" } ?: timeSlot(decision.waitingSince?.takeIf { waiting }, decision.createdAt, now)
    Surface(modifier.fillMaxWidth(), shape = shape, color = ground) {
        Column(
            Modifier.clickable(onClickLabel = "Open the question") { actions.open(decision.id) }
                .semantics {
                    if (waiting) stateDescription = label ?: "Waiting for you"
                    else if (until != null) stateDescription = "Snoozed until ${snoozeTime(until, now, h24)}"
                }
                .padding(Spacing.s5),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            MetaRow(decision.source, slot, clock = waiting)
            Row(verticalAlignment = Alignment.Top) {
                Symbol(Sym.Question, size = 22.dp, tint = icon, modifier = Modifier.padding(top = 1.dp))
                Spacer(Modifier.width(Spacing.s2))
                Text(decision.question, style = StarbridgeTheme.type.subtitle.weight(waiting), color = scheme.onSurface)
            }
            Images(decision.images, maxHeight = 160.dp, crop = true, modifier = Modifier.padding(vertical = Spacing.s1))
            val page = decision.answerIn
            // A snoozed card stays quiet, with no amber default: the owner opens it to answer.
            if (page != null && until == null && decision.takesDone && cardButtons(decision, buttons)) {
                Spacer(Modifier.height(Spacing.s1))
                val send = answer(decision, actions.answer)
                PageAndDone(page, replies.sending[decision.id] != null, other = if (waiting) scheme.surfaceContainer else scheme.surfaceContainerHighest) { send(null, null) }
            }
            if (until == null && cardOptions(decision, buttons)) {
                Spacer(Modifier.height(Spacing.s1))
                Options(decision, replies.sending[decision.id], height = 40.dp, other = if (waiting) scheme.surfaceContainer else scheme.surfaceContainerHighest, answer = answer(decision, actions.answer))
            }
        }
    }
}

/** A question's title: weight 500 while its agent waits on it, else 400. */
internal fun TextStyle.weight(waiting: Boolean) = if (waiting) this else copy(fontWeight = FontWeight(400))

/**
 * Whether a card carries the question's options: the setting decides, for every question with
 * options. One answered on another page, or in free text, opens its sheet instead.
 */
internal fun cardOptions(d: Decision, buttons: CardButtons) = d.answerIn == null && d.options.isNotEmpty() && cardButtons(d, buttons)

/** Whether the Answer buttons setting puts buttons on [d]'s card. */
internal fun cardButtons(d: Decision, buttons: CardButtons) = when (buttons) {
    CardButtons.Always -> true
    CardButtons.WhenWaiting -> d.waiting
    CardButtons.Never -> false
}

@Composable
private fun answer(decision: Decision, send: (String, String?, String?) -> Unit): (String?, String?) -> Unit {
    val haptics = LocalHapticFeedback.current
    return { choice, text ->
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        send(decision.id, choice, text)
    }
}

/**
 * The options as a connected group, the agent's default first and the one amber button. Side by
 * side when there are two short ones, else stacked; the one going out takes the check, and taps
 * are dropped until the server replies. In the sheet ([check]), stacked, the default takes a check.
 */
@Composable
fun Options(decision: Decision, sending: String?, height: Dp, other: Color, answer: (String?, String?) -> Unit, check: Boolean = false) {
    val colors = StarbridgeTheme.colors
    val ordered = decision.ordered
    val end = height / 2
    val pick = { option: String -> if (sending == null) answer(option, null) }
    val row = !check && ordered.size <= 2 && ordered.all { it.length <= 18 }
    @Composable
    fun One(i: Int, option: String, modifier: Modifier) {
        val first = i == 0
        val last = i == ordered.lastIndex
        val shape = if (row) {
            RoundedCornerShape(topStart = if (first) end else 8.dp, bottomStart = if (first) end else 8.dp, topEnd = if (last) end else 8.dp, bottomEnd = if (last) end else 8.dp)
        } else {
            RoundedCornerShape(topStart = if (first) end else 8.dp, topEnd = if (first) end else 8.dp, bottomStart = if (last) end else 8.dp, bottomEnd = if (last) end else 8.dp)
        }
        val recommended = option == decision.proposal
        Button(
            onClick = { pick(option) },
            shape = if (option == sending) RoundedCornerShape(end) else shape,
            colors = if (recommended) ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent)
            else ButtonDefaults.buttonColors(containerColor = if (option == sending) MaterialTheme.colorScheme.onSurface else other, contentColor = if (option == sending) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.onSurface),
            contentPadding = PaddingValues(horizontal = Spacing.s4),
            modifier = modifier.heightIn(min = height).semantics { if (recommended) stateDescription = "Default" },
        ) {
            if (check && recommended) {
                Symbol(Sym.Check, size = 18.dp)
                Spacer(Modifier.width(Spacing.s2))
            }
            Text(
                option,
                style = if (height > 48.dp) StarbridgeTheme.type.action else StarbridgeTheme.type.label,
                textAlign = TextAlign.Center,
            )
        }
    }
    if (row) {
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) { ordered.forEachIndexed { i, o -> One(i, o, Modifier.weight(1f)) } }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { ordered.forEachIndexed { i, o -> One(i, o, Modifier.fillMaxWidth()) } }
    }
}

/**
 * A question's sheet: the meta row and what the agent asked head it, filled or hollow as its card
 * is (#191); then its words and code, and the answer. Answered, it shows how it closed.
 */
@Composable
fun DecisionSheet(decision: Decision, now: Instant, onAnswer: (String, String?, String?) -> Unit, replies: Replies, onSnooze: ((Instant) -> Unit)? = null, snoozeOpen: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    val wasOpen = remember(decision.id) { decision.isOpen }
    val send = answer(decision, onAnswer)
    val sending = replies.sending[decision.id]
    val open = decision.isOpen
    val until = decision.snoozedUntil?.takeIf { decision.snoozed(now) }
    // Snoozed, nothing is amber, even when its agent waits: the owner said not now (#571).
    val waiting = open && decision.waiting && until == null
    val since = decision.waitingSince?.takeIf { waiting }
    val h24 = LocalClock24.current
    var replying by rememberSaveable(decision.id) { mutableStateOf(!replies.drafts[decision.id].isNullOrEmpty()) }
    var snoozing by rememberSaveable(decision.id) { mutableStateOf(snoozeOpen) }
    SheetBody(
        decision.source,
        timeSlot(since, decision.createdAt, now),
        decision.agent,
        blocked = if (waiting) since?.let { waitingLabel(it, now) } ?: "Waiting for you" else null,
        head = {
            Text(decision.question, style = StarbridgeTheme.type.question.weight(waiting), color = scheme.onSurface)
            if (until != null) {
                Row(Modifier.padding(top = Spacing.s3), verticalAlignment = Alignment.CenterVertically) {
                    Symbol(Sym.Snooze, size = 18.dp, tint = scheme.onSurfaceVariant)
                    Spacer(Modifier.width(Spacing.s2))
                    Text("Snoozed until ${snoozeTime(until, now, h24)}", style = StarbridgeTheme.type.small, color = scheme.onSurfaceVariant)
                }
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Context(decision.context)
            Links(decision.links)
            val paired = decision.images.size == decision.options.size && decision.images.size > 1 && decision.answerIn == null
            when {
                !open -> {
                    Images(decision.images, maxHeight = 360.dp)
                    Outcome(decision, now, arrived = wasOpen)
                }
                paired -> {
                    Picks(decision, sending, send)
                    if (decision.replies) Reply(decision.id, replies, sending != null) { send(null, it) }
                }
                else -> {
                    Images(decision.images, maxHeight = 360.dp)
                    val page = decision.answerIn
                    when {
                        page != null -> AnswerElsewhere(page)
                        decision.options.isEmpty() -> FreeText(replies.drafts[decision.id].orEmpty(), { replies.drafts[decision.id] = it }, sending != null) { send(null, it) }
                        else -> {
                            Options(decision, sending, height = 56.dp, other = scheme.surfaceContainerHighest, answer = send, check = true)
                            if (replying) Reply(decision.id, replies, sending != null) { send(null, it) }
                        }
                    }
                }
            }
            val reply = decision.replies && decision.options.isNotEmpty() && decision.answerIn == null && !paired && !replying
            val done = decision.answerIn != null && decision.takesDone
            if (open && (reply || done || onSnooze != null)) {
                // Quiet, so the options stay the answer: a typed reply (#201), Done for a page's
                // answer (#539), and putting it off (#571).
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s1), verticalAlignment = Alignment.CenterVertically) {
                    if (reply) Quiet("Reply") { replying = true }
                    if (done) Done(sending != null) { send(null, null) }
                    if (onSnooze != null) Quiet(if (until != null) "Snooze again" else "Snooze", sending == null) { snoozing = !snoozing }
                    if (onSnooze != null && until != null) Quiet("Back now", sending == null) { onSnooze(Instant.now()) }
                }
                if (onSnooze != null && snoozing) SnoozeTimes(now) { snoozing = false; onSnooze(it) }
            }
        }
    }
}

/**
 * "Pick a result": each image over the option it stands for, two to a row; picking one answers.
 * Each image keeps its own shape, no wider than its button, and the row's images are centred on
 * one midline, so the buttons under them line up ([PickImages], #536).
 */
@Composable
private fun Picks(decision: Decision, sending: String?, answer: (String?, String?) -> Unit) {
    val colors = StarbridgeTheme.colors
    var viewing by remember { mutableStateOf<Int?>(null) }
    BoxWithConstraints {
        val width = maxWidth
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            decision.images.indices.chunked(2).forEach { row ->
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                    PickImages(row.map { decision.images[it] }, width, Sizes.pick) { viewing = row[it] }
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                        row.forEach { i ->
                            val option = decision.options[i]
                            val recommended = option == decision.proposal
                            Button(
                                onClick = { if (sending == null) answer(option, null) },
                                colors = if (recommended) ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent)
                                else ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface),
                                modifier = Modifier.weight(1f).height(48.dp).semantics { if (recommended) stateDescription = "Default" },
                            ) { Text(option, style = StarbridgeTheme.type.action, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
    viewing?.let { ImageViewer(decision.images, it) { viewing = null } }
}

/**
 * "Reply" under the options, quiet: a typed answer in place of them, for when none is right
 * (#201). It opens the text field, which stays open while a draft is kept.
 */
@Composable
private fun Reply(id: String, replies: Replies, sending: Boolean, onAnswer: (String) -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (replies.drafts[id].isNullOrEmpty()) focus.requestFocus() }
    FreeText(replies.drafts[id].orEmpty(), { replies.drafts[id] = it }, sending, Modifier.focusRequester(focus), onAnswer)
}

/** A quiet text button under a question's answer: Reply, Back now. */
@Composable
private fun Quiet(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(onClick = onClick, enabled = enabled, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Text(label, style = StarbridgeTheme.type.label)
    }
}

@Composable
private fun FreeText(text: String, onText: (String) -> Unit, sending: Boolean, field: Modifier = Modifier, onAnswer: (String) -> Unit) {
    val send = { if (text.isNotBlank() && !sending) onAnswer(text.trim()) }
    // Material's text field, the send button its trailing icon, centred on the field's line (#254).
    TextField(
        value = text,
        onValueChange = { onText(it.take(4000)) },
        enabled = !sending,
        placeholder = { Text("Your answer") },
        trailingIcon = {
            IconButton(onClick = send, enabled = text.isNotBlank() && !sending) { Symbol(Sym.Send, contentDescription = "Send") }
        },
        textStyle = StarbridgeTheme.type.body,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { send() }),
        colors = fieldColors(),
        // A hardware keyboard's Enter sends and Shift+Enter starts a new line, as on the web (#562).
        modifier = field.fillMaxWidth().onPreviewKeyEvent {
            if (it.key == Key.Enter && !it.isShiftPressed) {
                if (it.type == KeyEventType.KeyDown) send()
                true
            } else false
        },
    )
}

/** Answered on that page, never here: the one button, amber since it is what needs the owner. */
@Composable
private fun AnswerElsewhere(page: Link) {
    val context = LocalContext.current
    val colors = StarbridgeTheme.colors
    Button(
        onClick = { openLink(context, page.url) },
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
        modifier = Modifier.fillMaxWidth().height(56.dp),
    ) {
        Symbol(Sym.Open, size = 20.dp)
        Spacer(Modifier.width(Spacing.s2))
        Text("Answer in ${page.place()}", style = StarbridgeTheme.type.action, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Done under the page's link in the sheet (#539): quiet, as Reply, since the page holds the
 * answer and Done only says it was given there.
 */
@Composable
private fun Done(sending: Boolean, onDone: () -> Unit) = Quiet("Done") { if (!sending) onDone() }

/** On a card: the page's link, amber, joined to a tonal Done (#539). */
@Composable
private fun PageAndDone(page: Link, sending: Boolean, other: Color, onDone: () -> Unit) {
    val context = LocalContext.current
    val colors = StarbridgeTheme.colors
    val end = 20.dp
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Button(
            onClick = { openLink(context, page.url) },
            shape = RoundedCornerShape(topStart = end, bottomStart = end, topEnd = 8.dp, bottomEnd = 8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
            contentPadding = PaddingValues(horizontal = Spacing.s4),
            modifier = Modifier.weight(1f).heightIn(min = 40.dp),
        ) {
            Symbol(Sym.Open, size = 18.dp)
            Spacer(Modifier.width(Spacing.s2))
            Text("Answer in ${page.place()}", style = StarbridgeTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Button(
            onClick = { if (!sending) onDone() },
            shape = RoundedCornerShape(topStart = 8.dp, bottomStart = 8.dp, topEnd = end, bottomEnd = end),
            colors = ButtonDefaults.buttonColors(containerColor = other, contentColor = MaterialTheme.colorScheme.onSurface),
            contentPadding = PaddingValues(horizontal = Spacing.s4),
            modifier = Modifier.heightIn(min = 40.dp),
        ) { Text("Done", style = StarbridgeTheme.type.label, maxLines = 1) }
    }
}

/** The answer, or how a question answered on another page closed. */
internal fun outcome(decision: Decision) = decision.answer ?: decision.theirAnswer ?: when {
    decision.settled == "withdrawn" -> "Withdrawn"
    decision.answerIn != null -> "Answered in ${decision.answerIn.place()}"
    else -> "Answered"
}

/** Who closed it: this phone, the agent (withdrawn, or for another page), or another device. */
internal fun answeredBy(decision: Decision) = when {
    decision.answer != null -> "this phone"
    decision.answeredOn != null -> decision.answeredOn
    decision.settled != null || decision.answerIn != null -> "the agent"
    else -> "another device"
}

/** How it closed. With [arrived], the answer just landed and the check springs in. */
@Composable
private fun Outcome(decision: Decision, now: Instant, arrived: Boolean) {
    val shown = remember { MutableTransitionState(!arrived).apply { targetState = true } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        AnimatedVisibility(visibleState = shown, enter = scaleIn(MaterialTheme.motionScheme.fastSpatialSpec())) {
            Symbol(Sym.CheckCircle, size = 20.dp, filled = true, tint = StarbridgeTheme.colors.ok)
        }
        Spacer(Modifier.width(Spacing.s2))
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurface)) { append(outcome(decision)) }
                append(" · on ${answeredBy(decision)}")
            },
            style = StarbridgeTheme.type.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Markdown's code, fenced or inline, in mono; everything else in the sans. */
@Composable
private fun Context(text: String) {
    val scheme = MaterialTheme.colorScheme
    text.split("```").forEachIndexed { i, part ->
        if (i % 2 == 1) {
            val code = part.substringAfter('\n', part).trimEnd()
            Surface(shape = RoundedCornerShape(Spacing.s4), color = scheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
                Text(code, style = StarbridgeTheme.type.code, color = scheme.onSurface, modifier = Modifier.padding(horizontal = Spacing.s4, vertical = Spacing.s3))
            }
        } else if (part.isNotBlank()) {
            Text(inline(part.trim(), scheme.surfaceContainerHighest), style = StarbridgeTheme.type.body, color = scheme.onSurfaceVariant)
        }
    }
}

private fun inline(text: String, background: Color): AnnotatedString = buildAnnotatedString {
    text.split('`').forEachIndexed { i, part ->
        if (i % 2 == 1) withStyle(SpanStyle(fontFamily = StarbridgeTheme.type.code.fontFamily, fontSize = 14.sp, background = background)) { append(part) }
        else append(part)
    }
}

/** What History holds: answered questions and ended prompts, newest first, and today's count. */
internal class History(decisions: List<Decision>, prompts: List<Prompt>, now: Instant) {
    val rows: List<Pair<Instant, Any>> = (
        decisions.map { (it.answeredAt ?: it.createdAt) to it } +
            prompts.map { (it.endedAt ?: it.expiresAt) to it }
        ).sortedByDescending { it.first }
    private val today = now.atZone(ZoneId.systemDefault()).toLocalDate()
    val todayCount = rows.count { it.first.atZone(ZoneId.systemDefault()).toLocalDate() == today }
}

/**
 * Snoozed (#571), collapsed and remembered, after what needs the owner: the questions they put
 * off, the soonest back first, on quiet cards that say when each comes back.
 */
private fun LazyListScope.snoozed(decisions: List<Decision>, now: Instant, open: Boolean, onOpen: (Boolean) -> Unit, actions: DecisionActions, replies: Replies, buttons: CardButtons, segmented: Boolean) {
    if (decisions.isEmpty()) return
    val joined = segmented && open
    val count = decisions.size + 1
    item(key = "snoozed") {
        SectionHead(Sym.Snooze, "Snoozed", "${decisions.size}", open, onOpen, if (joined) segment(0, count) else cardShape)
    }
    if (!open) return
    itemsIndexed(decisions, key = { _, it -> "s/${it.id}" }) { i, it ->
        val shape = if (joined) segment(i + 1, count) else cardShape
        DecisionCard(it, now, actions, replies, shape, buttons, sectionRow().padding(top = if (joined) 0.dp else cardGap - groupGap))
    }
}

/**
 * How many of the closed section heads wait at the bottom (#662, #682): History when closed, and
 * Snoozed above it when it is closed too, or when there is no History.
 */
private fun atBottom(snoozed: Boolean, snoozedOpen: Boolean, history: Boolean, historyOpen: Boolean): Int {
    if (history && historyOpen) return 0
    val historyDown = if (history) 1 else 0
    return historyDown + if (snoozed && !snoozedOpen) 1 else 0
}

/**
 * The head of a collapsed, remembered section: Snoozed or History. Moving between the bottom and
 * its place under the items, it glides as the cards do, over the rows it passes (#662).
 */
@Composable
private fun LazyItemScope.SectionHead(symbol: Sym, title: String, detail: String?, open: Boolean, onOpen: (Boolean) -> Unit, shape: Shape) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        Modifier.animateItem(placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec()).zIndex(1f).fillMaxWidth().padding(top = Spacing.s3).clip(shape).clickable(onClickLabel = if (open) "Hide $title" else "Show $title") { onOpen(!open) },
        shape = shape,
        color = scheme.surfaceContainer,
    ) {
        Row(Modifier.padding(horizontal = Spacing.s5, vertical = Spacing.s4), verticalAlignment = Alignment.CenterVertically) {
            Symbol(symbol, size = 20.dp, tint = scheme.onSurface)
            Spacer(Modifier.width(10.dp))
            Text(title, style = StarbridgeTheme.type.label.copy(fontSize = 15.sp), color = scheme.onSurface)
            Spacer(Modifier.width(10.dp))
            if (detail != null) Text(detail, style = StarbridgeTheme.type.small.copy(fontSize = 15.sp), color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            else Spacer(Modifier.weight(1f))
            Symbol(if (open) Sym.ExpandMore else Sym.Chevron, size = 20.dp, tint = scheme.onSurfaceVariant)
        }
    }
}

/** A section's row: it fades in once the head has nearly risen to it, not under it on its way (#662). */
@Composable
private fun LazyItemScope.sectionRow(): Modifier =
    Modifier.animateItem(fadeInSpec = tween(250, delayMillis = 200), placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec())

/** History, collapsed and remembered: one row per answered question or ended prompt. */
private fun LazyListScope.history(history: History, open: Boolean, onOpen: (Boolean) -> Unit, actions: DecisionActions, promptActions: PromptActions?, segmented: Boolean) {
    // Under a grouping, History's head and rows join as the groups above do.
    val joined = segmented && open
    val count = history.rows.size + 1
    if (history.rows.isEmpty()) return
    item(key = "history") {
        SectionHead(Sym.History, "History", if (history.todayCount > 0) "${history.todayCount} answered today" else null, open, onOpen, if (joined) segment(0, count) else cardShape)
    }
    if (!open) return
    itemsIndexed(history.rows, key = { _, (_, it) -> if (it is Decision) "h/d/${it.id}" else "h/p/${(it as Prompt).id}" }) { i, (at, it) ->
        // Apart, one-line cards round less, as Material scales a corner with its container.
        val shape = if (joined) segment(i + 1, count) else RoundedCornerShape(Spacing.s5)
        Box(sectionRow().padding(top = if (joined) 0.dp else cardGap - groupGap)) {
            when (it) {
                is Decision -> HistoryRow(it.source, it.question, false, closedHow(it), shape) { actions.open(it.id) }
                is Prompt -> HistoryRow(it.source, it.summary, true, closedHow(it), shape) { promptActions?.open?.invoke(it.id) }
            }
        }
    }
}

/** How a History row closed: the answer and who gave it, or how a prompt ended. */
internal fun closedHow(decision: Decision) = "${outcome(decision)} · on ${answeredBy(decision)}"
internal fun closedHow(prompt: Prompt) = prompt.ended ?: "Expired"

/**
 * One line of History, also Find's result row: the meta row, the question or command, and how it
 * closed, when it did ([how] empty while open). Find marks its [words] and passes an open row's
 * [ground] and time.
 */
@Composable
internal fun HistoryRow(
    source: Source,
    text: String,
    prompt: Boolean,
    how: String,
    shape: Shape,
    words: List<String> = emptyList(),
    ground: Color = MaterialTheme.colorScheme.surfaceContainer,
    time: String = "",
    clock: Boolean = false,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val hit = hitStyle()
    Surface(Modifier.fillMaxWidth().clickable(onClick = onClick), shape = shape, color = ground) {
        Column(Modifier.padding(horizontal = Spacing.s5, vertical = Spacing.s3), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            MetaRow(source, time, clock = clock, words = words)
            Text(highlight(text, words, hit), style = if (prompt) StarbridgeTheme.type.code.copy(fontSize = 13.sp) else StarbridgeTheme.type.small, color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (how.isNotEmpty()) Text(highlight(how, words, hit), style = StarbridgeTheme.type.meta, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A replacement of the recovery key made on another device (#348), said once. */
private fun LazyListScope.recoveryBanner(recovery: RecoveryUi?, dismiss: (Int) -> Unit) {
    val notice = recovery?.notice ?: return
    item(key = "recovery") {
        val scheme = MaterialTheme.colorScheme
        val h24 = LocalClock24.current
        Panel(Modifier.fillMaxWidth(), color = scheme.surfaceContainerHighest) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Recovery key replaced on ${notice.by}, ${day(notice.at)}, ${clock(notice.at, h24)}.",
                    style = StarbridgeTheme.type.body,
                    color = scheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { dismiss(notice.seq) }, colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSurface)) {
                    Text("OK", style = StarbridgeTheme.type.label)
                }
            }
        }
    }
}

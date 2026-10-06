package dev.starbridge.app.ui

import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ToggleButton
import androidx.compose.material3.ToggleButtonDefaults
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import androidx.compose.ui.unit.Density

/**
 * A top-level screen: a large flexible top app bar that collapses as the content scrolls, over
 * [content], which gets the padding to apply. The navigation suite and the root scaffold already
 * take the system bars, so this one takes no insets.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Screen(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0),
        topBar = {
            LargeFlexibleTopAppBar(
                title = { Text(title) },
                subtitle = subtitle,
                actions = actions,
                windowInsets = WindowInsets(0),
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    scrolledContainerColor = MaterialTheme.colorScheme.surface,
                ),
                scrollBehavior = scroll,
            )
        },
        containerColor = MaterialTheme.colorScheme.surface,
    ) { padding ->
        // Wide windows cap the content at `size.content` (DESIGN.md).
        Box(Modifier.widthIn(max = Sizes.content)) { content(padding) }
    }
}

/**
 * A top-level page, as the mockups draw it: a large title that scrolls away with the list under
 * it, cards [gap] apart in a 12 dp gutter. [onBack] adds a back button and sets the title a size
 * smaller, for a page inside a tab. [trailing] sits at the title's baseline end.
 */
@Composable
fun Page(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    onBack: (() -> Unit)? = null,
    refresh: Refresh? = null,
    gap: Dp = groupGap,
    /** Space beside the content, each side. */
    margin: Dp = Spacing.s3,
    /** Space under the title; a page that starts with a section name needs less. */
    titleGap: Dp = Spacing.s3,
    /** Above the title: the Inbox's lockup. */
    header: (@Composable () -> Unit)? = null,
    /** The last item waits at the bottom of the screen while everything fits: the Inbox's History. */
    lastAtBottom: Boolean = false,
    content: LazyListScope.() -> Unit,
) {
    Refreshable(refresh) {
        LazyColumn(
            modifier.fillMaxSize().widthIn(max = Sizes.content),
            contentPadding = PaddingValues(start = margin, end = margin, bottom = Spacing.s6),
            verticalArrangement = if (lastAtBottom) LastAtBottom(gap) else Arrangement.spacedBy(gap),
        ) {
            item(key = "page-title") { PageTitle(title, subtitle, trailing, onBack, titleGap - gap, header) }
            content()
        }
    }
}

/** [gap] between items, as `spacedBy`, with the last one moved down to the bottom when they fit. */
private class LastAtBottom(private val gap: Dp) : Arrangement.Vertical {
    override val spacing = gap

    override fun Density.arrange(totalSize: Int, sizes: IntArray, outPositions: IntArray) {
        with(Arrangement.spacedBy(gap)) { arrange(totalSize, sizes, outPositions) }
        if (sizes.size < 2) return
        val last = sizes.lastIndex
        outPositions[last] = maxOf(outPositions[last], totalSize - sizes[last])
    }

    override fun equals(other: Any?) = other is LastAtBottom && other.gap == gap
    override fun hashCode() = gap.hashCode()
}

@Composable
private fun PageTitle(title: String, subtitle: (@Composable () -> Unit)?, trailing: (@Composable () -> Unit)?, onBack: (() -> Unit)?, bottom: Dp, header: (@Composable () -> Unit)?) {
    val scheme = MaterialTheme.colorScheme
    Column {
        if (header != null) Box(Modifier.padding(start = Spacing.s1, top = Spacing.s4)) { header() }
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.padding(vertical = Spacing.s2).offset(x = -Spacing.s2)) {
                Symbol(Sym.Back, size = 22.dp, tint = scheme.onSurface, contentDescription = "Back")
            }
        }
        val style = if (onBack != null) StarbridgeTheme.type.title else StarbridgeTheme.type.display
        TitleRow(
            Modifier.padding(start = Spacing.s1, top = if (onBack != null) Spacing.s2 else if (header != null) Spacing.s4 else Spacing.s6, bottom = bottom),
            title = {
                // One line, as tall as its line height: the face's own height is more at this size,
                // and CSS lets the glyphs overflow the line where Compose would grow the box.
                val line = with(LocalDensity.current) { style.lineHeight.toDp() }
                Text(title, style = style, color = scheme.onSurface, maxLines = 1, modifier = Modifier.height(line).wrapContentHeight(unbounded = true))
            },
            subtitle = subtitle?.let {
                {
                    Column {
                        Spacer(Modifier.height(2.dp))
                        CompositionLocalProvider(LocalContentColor provides scheme.onSurfaceVariant, LocalTextStyle provides StarbridgeTheme.type.body) { it() }
                    }
                }
            },
            trailing = trailing?.let { { Row(verticalAlignment = Alignment.Bottom) { it() } } },
        )
    }
}

/**
 * The title and the subtitle under it, with [trailing] at their end, bottom-aligned. When the
 * title's one line and [trailing] don't fit side by side, [trailing] takes a line of its own under
 * them, at the end.
 */
@Composable
private fun TitleRow(modifier: Modifier, title: @Composable () -> Unit, subtitle: (@Composable () -> Unit)?, trailing: (@Composable () -> Unit)?) {
    Layout(listOf(title, subtitle ?: {}, trailing ?: {}), modifier) { (t, s, e), c ->
        val end = e.firstOrNull()?.measure(c.copy(minWidth = 0, minHeight = 0))
        val beside = end == null || t.first().maxIntrinsicWidth(c.maxHeight) + end.width <= c.maxWidth
        val width = if (beside) c.maxWidth - (end?.width ?: 0) else c.maxWidth
        val inner = c.copy(minWidth = 0, maxWidth = width, minHeight = 0)
        val head = t.first().measure(inner)
        val sub = s.firstOrNull()?.measure(inner)
        val text = head.height + (sub?.height ?: 0)
        val height = if (beside) maxOf(text, end?.height ?: 0) else text + (end?.height ?: 0)
        layout(c.maxWidth, height) {
            head.place(0, if (beside) height - text else 0)
            sub?.place(0, (if (beside) height - text else 0) + head.height)
            end?.place(c.maxWidth - end.width, height - end.height)
        }
    }
}

/** A section's name over its group of rows. */
@Composable
fun Section(text: String) {
    Text(
        text,
        style = StarbridgeTheme.type.label,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Spacing.s2, top = Spacing.s5 - groupGap, bottom = Spacing.s2 - groupGap),
    )
}

/** Pull to refresh: whether a sync runs, and how to start one. */
class Refresh(val busy: Boolean, val run: () -> Unit)

/**
 * One screen's pull to refresh. The store's [busy] counts every sync the owner asked for, on any
 * screen, so the indicator shows only on the screen whose pull started one, until it ends.
 */
@Composable
fun pulled(busy: Boolean, run: () -> Unit): Refresh {
    // Not saved: the Inbox stays on the back stack under every tab, and a saved pull would come
    // back with it while another screen's sync runs.
    var mine by remember { mutableStateOf(false) }
    val now by rememberUpdatedState(busy)
    LaunchedEffect(mine) {
        if (!mine) return@LaunchedEffect
        // The sync raises busy from another thread; one that never shows it ended already.
        withTimeoutOrNull(2_000) { snapshotFlow { now }.first { it } }
        snapshotFlow { now }.first { !it }
        mine = false
    }
    return Refresh(mine && busy) {
        mine = true
        run()
    }
}

/** Pull to refresh with the expressive loading indicator; [refresh] null leaves [content] as is. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Refreshable(refresh: Refresh?, content: @Composable () -> Unit) {
    if (refresh == null) return content()
    val state = rememberPullToRefreshState()
    PullToRefreshBox(
        isRefreshing = refresh.busy,
        onRefresh = refresh.run,
        state = state,
        indicator = { PullToRefreshDefaults.LoadingIndicator(state = state, isRefreshing = refresh.busy, modifier = Modifier.align(Alignment.TopCenter)) },
    ) { content() }
}

/** The padding of a screen's list: the gutter, and room below the last card. */
fun listPadding(scaffold: PaddingValues) = PaddingValues(
    start = Spacing.s4,
    end = Spacing.s4,
    top = scaffold.calculateTopPadding() + Spacing.s2,
    bottom = scaffold.calculateBottomPadding() + Spacing.s6,
)

/** A section name, as DESIGN.md's label role. */
@Composable
fun Label(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, style = StarbridgeTheme.type.label, color = color, modifier = modifier)
}

/** The beacon: a dot in amber where something needs the owner. */
@Composable
fun Beacon(modifier: Modifier = Modifier, color: Color = StarbridgeTheme.colors.accent) {
    Box(modifier.size(Spacing.s2).background(color, CircleShape))
}

/** A status word with its dot: quota pace, device state. Colour never goes without the word. */
@Composable
fun StatusWord(word: String, color: Color, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Beacon(color = color)
        Spacer(Modifier.width(Spacing.s2))
        Text(word, style = StarbridgeTheme.type.label, color = color)
    }
}

/** A card: filled `surfaceContainer` (DESIGN.md's `surface`) on the ground, `radius.xl`, no border and no shadow. */
@Composable
fun Panel(modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.surfaceContainer, shape: Shape = RoundedCornerShape(Radius.xl), content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier = modifier, shape = shape, color = color) {
        Column(Modifier.padding(Spacing.s5), content = content)
    }
}

/**
 * The shape of row [index] of [count] in a grouped list (Material 3 Expressive): the group's outer
 * corners round as a card, the inner ones stay tight, and rows sit [groupGap] apart, as the
 * buttons of a connected group do.
 */
fun groupShape(index: Int, count: Int, outer: Dp = Radius.xl, inner: Dp = Radius.xs): Shape {
    val first = index == 0
    val last = index == count - 1
    return RoundedCornerShape(
        topStart = if (first) outer else inner,
        topEnd = if (first) outer else inner,
        bottomStart = if (last) outer else inner,
        bottomEnd = if (last) outer else inner,
    )
}

/** A card in a feed of cards (inbox, quotas): rounder outside, 6 dp inside. */
fun cardShape(index: Int, count: Int) = groupShape(index, count, outer = Spacing.s6, inner = 6.dp)

/** A row of a settings group. */
fun rowShape(index: Int, count: Int) = groupShape(index, count, outer = Spacing.s5, inner = Radius.xs)

/** Cards and rows of one group sit this far apart. */
val groupGap = 2.dp

/**
 * A single-select connected button group (Material 3 Expressive), which replaces segmented
 * buttons: the picked choice is filled and fully round.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun <T> Choice(choices: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween)) {
        choices.forEachIndexed { i, (value, label) ->
            ToggleButton(
                checked = value == selected,
                onCheckedChange = { onSelect(value) },
                modifier = Modifier.weight(1f).heightIn(min = Sizes.tap).semantics { role = Role.RadioButton },
                shapes = when (i) {
                    0 -> ButtonGroupDefaults.connectedLeadingButtonShapes()
                    choices.lastIndex -> ButtonGroupDefaults.connectedTrailingButtonShapes()
                    else -> ButtonGroupDefaults.connectedMiddleButtonShapes()
                },
                // Unchecked on the highest container, so choices stand out from the card they sit on.
                colors = ToggleButtonDefaults.colors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                    checkedContainerColor = MaterialTheme.colorScheme.primary,
                    checkedContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            ) { Text(label, style = StarbridgeTheme.type.action, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** A filled text field on a card: the highest container, so it stands out from the card. */
@Composable
fun fieldColors() = MaterialTheme.colorScheme.surfaceContainerHighest.let {
    TextFieldDefaults.colors(
        focusedContainerColor = it,
        unfocusedContainerColor = it,
        disabledContainerColor = it,
        errorContainerColor = it,
        unfocusedIndicatorColor = MaterialTheme.colorScheme.outline,
    )
}

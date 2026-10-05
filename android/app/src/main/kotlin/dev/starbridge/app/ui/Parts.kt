package dev.starbridge.app.ui

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
    /** Space under the title; a page that starts with a section name needs less. */
    titleGap: Dp = Spacing.s3,
    content: LazyListScope.() -> Unit,
) {
    Refreshable(refresh) {
        LazyColumn(
            modifier.fillMaxSize().widthIn(max = Sizes.content),
            contentPadding = PaddingValues(start = Spacing.s3, end = Spacing.s3, bottom = Spacing.s6),
            verticalArrangement = Arrangement.spacedBy(gap),
        ) {
            item(key = "page-title") { PageTitle(title, subtitle, trailing, onBack, titleGap - gap) }
            content()
        }
    }
}

@Composable
private fun PageTitle(title: String, subtitle: (@Composable () -> Unit)?, trailing: (@Composable () -> Unit)?, onBack: (() -> Unit)?, bottom: Dp) {
    val scheme = MaterialTheme.colorScheme
    Column {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.padding(vertical = Spacing.s2).offset(x = -Spacing.s2)) {
                Symbol(Sym.Back, size = 22.dp, tint = scheme.onSurface, contentDescription = "Back")
            }
        }
        Row(
            Modifier.padding(start = Spacing.s1, top = if (onBack != null) Spacing.s2 else Spacing.s6, bottom = bottom),
            verticalAlignment = Alignment.Bottom,
        ) {
            Column(Modifier.weight(1f)) {
                val style = if (onBack != null) StarbridgeTheme.type.title else StarbridgeTheme.type.display
                // One line, as tall as its line height: the face's own height is more at this size,
                // and CSS lets the glyphs overflow the line where Compose would grow the box.
                val line = with(LocalDensity.current) { style.lineHeight.toDp() }
                Text(title, style = style, color = scheme.onSurface, maxLines = 1, modifier = Modifier.height(line).wrapContentHeight(unbounded = true))
                if (subtitle != null) {
                    Spacer(Modifier.height(2.dp))
                    CompositionLocalProvider(LocalContentColor provides scheme.onSurfaceVariant, LocalTextStyle provides StarbridgeTheme.type.body) { subtitle() }
                }
            }
            trailing?.invoke()
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
            ) { Text(label, style = StarbridgeTheme.type.action, maxLines = 1) }
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

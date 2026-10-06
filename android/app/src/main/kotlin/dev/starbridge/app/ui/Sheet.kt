package dev.starbridge.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.animation.animateColorAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.scene.OverlayScene
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope
import dev.starbridge.app.data.Source
import dev.starbridge.app.ui.inbox.MetaRow
import dev.starbridge.app.ui.inbox.SessionLine
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

/** The sheet's top corners, as Material's bottom sheet. */
val SheetShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)

/**
 * The drag handle: 32 by 4 dp in a 48 dp band, on the [ground] of the head under it. The band is a
 * full tap target: above it is the scrim, which takes the taps there.
 */
@Composable
fun SheetHandle(ground: Color = Color.Transparent) {
    Box(Modifier.fillMaxWidth().height(48.dp).background(ground), contentAlignment = Alignment.Center) {
        Box(Modifier.size(32.dp, 4.dp).background(StarbridgeTheme.colors.fg3, RoundedCornerShape(2.dp)))
    }
}

/** The ground a sheet's head sets, so the handle above it, drawn by the sheet, takes it too. */
class SheetGround {
    var color by mutableStateOf(Color.Transparent)
}

val LocalSheetGround = staticCompositionLocalOf { SheetGround() }

/**
 * A question's or a prompt's sheet: the head (the meta row and [head]), then [content], and the
 * session line, with "Open in Claude" or "Open in Codex", ends it. While it blocks an agent,
 * [blocked] says for how long: the head and the handle sit on amber's faint ground, the time slot
 * ticks, and a screen reader hears it first (#191).
 */
@Composable
fun SheetBody(source: Source, time: String, agent: String?, blocked: String? = null, head: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ground by animateColorAsState(
        if (blocked != null) StarbridgeTheme.colors.accentSoft.compositeOver(scheme.surfaceContainer) else scheme.surfaceContainer,
        MaterialTheme.motionScheme.fastEffectsSpec(),
    )
    val sheet = LocalSheetGround.current
    SideEffect { sheet.color = ground }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        Column(
            Modifier.fillMaxWidth().background(ground).padding(start = Spacing.s4, end = Spacing.s4, bottom = Spacing.s4)
                .semantics(mergeDescendants = true) { if (blocked != null) stateDescription = blocked },
        ) {
            MetaRow(source, time, Modifier.padding(top = 6.dp, bottom = 14.dp), clock = blocked != null)
            head()
        }
        // Below a filled head, the body keeps its distance from the ground's edge.
        Column(Modifier.padding(start = Spacing.s4, end = Spacing.s4, top = if (blocked != null) 14.dp else 0.dp, bottom = Spacing.s4)) {
            content()
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, modifier = Modifier.padding(top = 14.dp))
            SessionLine(source, agent, Modifier.padding(top = Spacing.s1))
        }
    }
}

/** Marks an entry to show in a modal bottom sheet over the page under it. */
class BottomSheetSceneStrategy<T : Any> : SceneStrategy<T> {
    companion object {
        private const val KEY = "starbridge.sheet"

        /** An entry's metadata for a sheet. */
        val sheet: Map<String, Any> = mapOf(KEY to true)
    }

    override fun SceneStrategyScope<T>.calculateScene(entries: List<NavEntry<T>>): Scene<T>? {
        val last = entries.lastOrNull() ?: return null
        if (last.metadata[KEY] != true) return null
        return SheetScene(last, entries.dropLast(1), onBack)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
private class SheetScene<T : Any>(
    private val entry: NavEntry<T>,
    override val previousEntries: List<NavEntry<T>>,
    private val onBack: () -> Unit,
) : OverlayScene<T> {
    override val key: Any = entry.contentKey
    override val entries = listOf(entry)
    override val overlaidEntries = previousEntries
    override val content: @Composable () -> Unit = {
        val ground = remember { SheetGround() }
        ModalBottomSheet(
            onDismissRequest = onBack,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            shape = SheetShape,
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            scrimColor = StarbridgeTheme.colors.scrim,
            dragHandle = { SheetHandle(ground.color) },
        ) { CompositionLocalProvider(LocalSheetGround provides ground) { entry.Content() } }
    }

    override fun equals(other: Any?) = other is SheetScene<*> && other.entry == entry
    override fun hashCode() = entry.hashCode()
}

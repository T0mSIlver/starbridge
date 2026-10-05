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
import androidx.compose.runtime.Composable
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

/** The drag handle: 32 by 4 dp in a 36 dp band. */
@Composable
fun SheetHandle() {
    Box(Modifier.fillMaxWidth().height(36.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(32.dp, 4.dp).background(StarbridgeTheme.colors.fg3, RoundedCornerShape(2.dp)))
    }
}

/**
 * A question's or a prompt's sheet: the meta row heads it and the session line, with "Open in
 * Claude" or "Open in Codex", ends it.
 */
@Composable
fun SheetBody(source: Source, time: String, agent: String?, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = Spacing.s4, end = Spacing.s4, bottom = Spacing.s4)) {
        MetaRow(source, time, Modifier.padding(top = 6.dp, bottom = 14.dp))
        content()
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, modifier = Modifier.padding(top = 14.dp))
        SessionLine(source, agent, Modifier.padding(top = Spacing.s1))
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
        ModalBottomSheet(
            onDismissRequest = onBack,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            shape = SheetShape,
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            scrimColor = StarbridgeTheme.colors.scrim,
            dragHandle = { SheetHandle() },
        ) { entry.Content() }
    }

    override fun equals(other: Any?) = other is SheetScene<*> && other.entry == entry
    override fun hashCode() = entry.hashCode()
}

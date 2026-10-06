package dev.starbridge.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.BottomBar
import dev.starbridge.app.ui.Tab
import dev.starbridge.app.ui.SheetHandle
import dev.starbridge.app.ui.SheetGround
import dev.starbridge.app.ui.LocalSheetGround
import androidx.compose.runtime.remember
import androidx.compose.runtime.CompositionLocalProvider
import dev.starbridge.app.ui.SheetShape
import dev.starbridge.app.ui.theme.StarbridgeTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.ui.NavDisplay

/**
 * A screen as the phone lays it out, for screenshots that line up with the mockups: the status
 * bar's 36 dp and the gesture bar's 24 dp, which Robolectric leaves out, and the bottom bar on
 * [tab]'s pages.
 */
@Composable
fun Phone(tab: Tab?, needYou: Int, content: @Composable () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(scheme.surface)) {
        Spacer(Modifier.height(36.dp))
        Box(Modifier.weight(1f)) { content() }
        if (tab != null) BottomBar(tab, needYou, {})
        Spacer(Modifier.fillMaxWidth().height(24.dp).background(if (tab != null) scheme.surfaceContainer else scheme.surface))
    }
}

/**
 * A sheet as the app shows it, drawn in place for screenshots, which see only the main window:
 * [behind] under the scrim, then the sheet with its handle, from the bottom.
 */
@Composable
fun Sheet(behind: @Composable () -> Unit, sheet: @Composable () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(scheme.surface)) {
        Spacer(Modifier.height(36.dp))
        Box(Modifier.weight(1f)) {
            behind()
            Box(Modifier.fillMaxSize().background(StarbridgeTheme.colors.scrim))
            Surface(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), shape = SheetShape, color = scheme.surfaceContainer) {
                val ground = remember { SheetGround() }
                Column { SheetHandle(ground.color); CompositionLocalProvider(LocalSheetGround provides ground) { sheet() } }
            }
        }
        Spacer(Modifier.fillMaxWidth().height(24.dp).background(scheme.surfaceContainer))
    }
}

/** [content] as an entry of the app's NavDisplay, which fills the screen and so hands it the full height as a minimum (#341). */
@Composable
fun Entry(content: @Composable () -> Unit) {
    NavDisplay(listOf(Unit), Modifier.fillMaxSize(), entryProvider = entryProvider { entry<Unit> { content() } })
}

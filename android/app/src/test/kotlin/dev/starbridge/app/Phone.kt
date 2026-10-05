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

package dev.starbridge.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Main
import dev.starbridge.app.ui.Setup
import dev.starbridge.app.ui.theme.StarbridgeTheme
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var store: Store

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        // The bars' icons follow the system's light or dark mode, as the theme does.
        enableEdgeToEdge(SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        setContent {
            StarbridgeTheme {
                val setUp by store.setUp.collectAsStateWithLifecycle()
                val decisions by store.decisions.collectAsStateWithLifecycle()
                val pairings by store.pairings.collectAsStateWithLifecycle()
                if (setUp) Main(openDecisions = decisions.count { it.answer == null }, pairings = pairings.size)
                else Setup()
            }
        }
    }
}

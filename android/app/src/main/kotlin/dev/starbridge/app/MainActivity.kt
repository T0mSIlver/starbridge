package dev.starbridge.app

import android.Manifest
import android.content.Intent
import android.content.res.Resources
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.net.toUri
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Main
import dev.starbridge.app.ui.Setup
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import java.time.Instant
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var store: Store
    @Inject lateinit var prefs: Prefs

    /** Decisions to open, from a notification tap. */
    private val openDecision = Channel<String>(Channel.CONFLATED)

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        // The bars' icons follow the system's light or dark mode, as the theme does.
        enableEdgeToEdge(SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        handle(intent)
        setContent {
            val colours by prefs.colours.collectAsStateWithLifecycle()
            LaunchedEffect(colours) { splashFor(colours) }
            StarbridgeTheme(colours = colours) {
                // The window shows behind the keyboard and between screens: the theme's ground.
                val ground = MaterialTheme.colorScheme.surface
                SideEffect { window.setBackgroundDrawable(ColorDrawable(ground.toArgb())) }
                val phase by store.phase.collectAsStateWithLifecycle()
                val decisions by store.decisions.collectAsStateWithLifecycle()
                LaunchedEffect(phase) {
                    // The recovery words stay out of screenshots and the recents screen.
                    if (phase is Phase.RecoveryKey) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    if (phase == Phase.Ready) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                        store.refresh()
                    }
                }
                if (phase == Phase.Ready) {
                    Main(decisions.count { it.isOpen(Instant.now()) }, store.notice, store::dismissNotice, openDecision.receiveAsFlow())
                } else {
                    Setup(phase, store.notice, store::dismissNotice, ::openInBrowser)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        if (store.phase.value == Phase.Ready) store.refresh()
    }

    private fun handle(intent: Intent?) {
        val data = intent?.data
        if (data?.scheme == "starbridge" && data.host == "auth") {
            store.receiveSignIn(data.toString())
            setIntent(Intent(this, MainActivity::class.java))
        }
        intent?.getStringExtra(EXTRA_DECISION)?.let {
            openDecision.trySend(it)
            intent.removeExtra(EXTRA_DECISION)
        }
    }

    /** The next cold start's splash: the manifest's, or the wallpaper's ground (Android 13 and later). */
    private fun splashFor(colours: Colours) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        splashScreen.setSplashScreenTheme(if (colours == Colours.Wallpaper) R.style.Theme_Starbridge_Starting_Wallpaper else Resources.ID_NULL)
    }

    private fun openInBrowser(url: String) {
        CustomTabsIntent.Builder().build().launchUrl(this, url.toUri())
    }

    companion object {
        const val EXTRA_DECISION = "decision"
    }
}

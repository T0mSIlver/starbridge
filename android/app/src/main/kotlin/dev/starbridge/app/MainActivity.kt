package dev.starbridge.app

import android.Manifest
import android.content.Intent
import android.content.res.Resources
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.text.format.DateFormat
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.toArgb
import androidx.core.net.toUri
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import dev.starbridge.app.data.Clock
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.Store
import androidx.navigation3.runtime.NavKey
import dev.starbridge.app.ui.DecisionKey
import dev.starbridge.app.ui.LocalClock24
import dev.starbridge.app.ui.Main
import dev.starbridge.app.ui.PromptKey
import dev.starbridge.app.ui.Setup
import dev.starbridge.app.ui.pairing.JoinActions
import dev.starbridge.app.ui.pairing.JoinPrompt
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var store: Store
    @Inject lateinit var prefs: Prefs

    /** Questions and prompts to open, from a notification tap. */
    private val opening = Channel<NavKey>(Channel.CONFLATED)

    /** The phone's 12/24-hour choice, read again on resume: changing it is no configuration change. */
    private val system24 = mutableStateOf(true)

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
            val clock by prefs.clock.collectAsStateWithLifecycle()
            val h24 = when (clock) {
                Clock.System -> system24.value
                Clock.H12 -> false
                Clock.H24 -> true
            }
            StarbridgeTheme(colours = colours) { CompositionLocalProvider(LocalClock24 provides h24) {
                // The window shows behind the keyboard and between screens: the theme's ground.
                val ground = MaterialTheme.colorScheme.surface
                SideEffect { window.setBackgroundDrawable(ColorDrawable(ground.toArgb())) }
                val phase by store.phase.collectAsStateWithLifecycle()
                val decisions by store.decisions.collectAsStateWithLifecycle()
                LaunchedEffect(phase) {
                    // The recovery key's screens keep themselves out of screenshots (SetupScreen).
                    if (phase == Phase.Ready) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                        store.refresh(shown = false)
                    }
                }
                if (phase == Phase.Ready) {
                    Main(decisions, store.notice, store::dismissNotice, opening.receiveAsFlow())
                    val asks by store.joinAsks.collectAsStateWithLifecycle()
                    val comparison by store.comparison.collectAsStateWithLifecycle()
                    JoinPrompt(asks, comparison, JoinActions(store::compareJoin, store::approveJoin, store::refuseJoin, store::closeComparison))
                } else {
                    Setup(phase, store.notice, store::dismissNotice, ::openInBrowser)
                }
            } }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        system24.value = DateFormat.is24HourFormat(this)
        // Pull to refresh shows its indicator; the syncs on launch and resume run without it.
        if (store.phase.value == Phase.Ready) store.refresh(shown = false)
        // Join requests arrive live while the app is in front; a push covers the rest.
        store.watchJoins(true)
    }

    override fun onPause() {
        super.onPause()
        store.watchJoins(false)
    }

    private fun handle(intent: Intent?) {
        val data = intent?.data
        if (data?.scheme == "starbridge" && data.host == "auth") {
            store.receiveSignIn(data.toString())
            setIntent(Intent(this, MainActivity::class.java))
        }
        intent?.getStringExtra(EXTRA_DECISION)?.let {
            opening.trySend(DecisionKey(it))
            intent.removeExtra(EXTRA_DECISION)
        }
        intent?.getStringExtra(EXTRA_PROMPT)?.let {
            opening.trySend(PromptKey(it))
            intent.removeExtra(EXTRA_PROMPT)
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
        const val EXTRA_PROMPT = "prompt"
    }
}

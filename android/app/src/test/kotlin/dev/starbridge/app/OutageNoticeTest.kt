package dev.starbridge.app

import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.starbridge.app.data.Reach
import dev.starbridge.app.ui.Notices
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The snackbar stays away for a 2 s outage, speaks after a long one, and leaves on its own (#920). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OutageNoticeTest {
    @get:Rule val compose = createComposeRule()

    private val offline = "Offline. Retrying when you're back online."
    private val unreachable = "Can't reach starbridge.run. Retrying."

    @Test
    fun onlyALongOutageShowsAMessage() {
        compose.mainClock.autoAdvance = false
        lateinit var reach: Reach
        val notice = MutableStateFlow<String?>(null)
        val connection = MutableStateFlow<String?>(null)
        compose.setContent {
            // The tracker's timer runs on the test's clock.
            val scope = rememberCoroutineScope()
            reach = remember { Reach(scope) { compose.mainClock.currentTime } }
            LaunchedEffect(Unit) { reach.status.collect { connection.value = Reach.words(it, "starbridge.run") } }
            StarbridgeTheme {
                val host = Notices(notice, { notice.value = null }, connection = connection)
                Scaffold(snackbarHost = { SnackbarHost(host) }) { }
            }
        }
        fun after(ms: Long) {
            compose.mainClock.advanceTimeBy(ms)
            compose.waitForIdle()
        }
        after(100)

        // Unlocked while the network comes back: 2 s offline, then the sync gets through.
        reach.resumed()
        reach.network(false)
        after(2_000)
        reach.network(true)
        reach.reached()
        after(30_000)
        compose.onNodeWithText(offline).assertDoesNotExist()
        compose.onNodeWithText(unreachable).assertDoesNotExist()

        // A server that stays away on a working network: said after the quiet time, gone once it answers.
        reach.failed()
        after(Reach.QUIET_MS - 1_000)
        compose.onNodeWithText(unreachable).assertDoesNotExist()
        after(2_000)
        compose.onNodeWithText(unreachable).assertExists()
        // Still up long after a short snackbar would have gone.
        after(30_000)
        compose.onNodeWithText(unreachable).assertExists()
        reach.reached()
        after(1_000)
        compose.onNodeWithText(unreachable).assertDoesNotExist()

        // Offline for long: said, and replaced by a notice while one shows.
        reach.network(false)
        after(Reach.QUIET_MS + 1_000)
        compose.onNodeWithText(offline).assertExists()
        notice.value = "Already answered on another device."
        after(1_000)
        compose.onNodeWithText("Already answered on another device.").assertExists()
        compose.onNodeWithText(offline).assertDoesNotExist()
    }
}

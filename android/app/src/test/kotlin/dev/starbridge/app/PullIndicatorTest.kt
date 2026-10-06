package dev.starbridge.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.starbridge.app.ui.Refresh
import dev.starbridge.app.ui.pulled
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// A pull's indicator belongs to the screen that was pulled, though the store's busy is shared.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PullIndicatorTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun aPullOnQuotasShowsNothingOnTheInbox() {
        var busy by mutableStateOf(false)
        var tab by mutableStateOf("quotas")
        lateinit var quotas: Refresh
        lateinit var inbox: Refresh
        compose.setContent {
            if (tab == "quotas") quotas = pulled(busy) { busy = true } else inbox = pulled(busy) {}
        }

        compose.runOnIdle { quotas.run() }
        compose.runOnIdle { assertTrue(quotas.busy) }

        compose.runOnIdle { tab = "inbox" }
        compose.runOnIdle { assertFalse(inbox.busy) }

        // The sync ends; a later one the owner didn't start on this screen shows nothing either.
        compose.runOnIdle { busy = false }
        compose.runOnIdle { busy = true }
        compose.runOnIdle { assertFalse(inbox.busy) }
    }
}

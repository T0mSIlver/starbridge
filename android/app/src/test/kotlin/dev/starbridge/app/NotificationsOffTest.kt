package dev.starbridge.app

import android.app.Application
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

// The inbox's "Notifications are off" line goes for good once dismissed (#342).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class NotificationsOffTest {
    @get:Rule val compose = createComposeRule()

    @Test fun dismissingHidesTheLineForGood() {
        val prefs = Prefs(ApplicationProvider.getApplicationContext<Application>())
        compose.setContent {
            val view by prefs.inbox.collectAsState()
            StarbridgeTheme { InboxScreen(emptyList(), Instant.now(), DecisionActions({ _, _, _ -> }, {}), view = view, onView = prefs::setInbox, notificationsOff = true) }
        }
        compose.onNodeWithText("Notifications are off").assertExists()
        compose.onNodeWithContentDescription("Don't remind me").performClick()
        compose.onNodeWithText("Notifications are off").assertDoesNotExist()
        assertFalse(Prefs(ApplicationProvider.getApplicationContext<Application>()).inbox.value.remindOff)
    }
}

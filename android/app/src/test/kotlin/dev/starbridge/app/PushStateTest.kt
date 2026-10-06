package dev.starbridge.app

import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.ui.settings.pushState
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// "Delivered through" names the server a registered phone gets its pushes from.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PushStateTest {
    private val registered = PushSetting("fcm", fcmAvailable = true, distributors = emptyList(), registered = true)

    @Test
    fun registeredNamesTheServersHost() {
        assertEquals("Registered with starbridge.run", pushState(registered, "https://starbridge.run"))
        assertEquals("Registered with sb.example.org", pushState(registered, "https://sb.example.org:8443/"))
        assertEquals("Registered with sb_server", pushState(registered, "http://sb_server:8080"))
        assertEquals("Not registered yet", pushState(registered.copy(registered = false), "https://starbridge.run"))
    }
}

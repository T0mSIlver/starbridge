package dev.starbridge.app

import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.ui.settings.pushState
import org.junit.Assert.assertEquals
import org.junit.Test

// "Delivered through" names the server a registered phone gets its pushes from.
class PushStateTest {
    private val registered = PushSetting("fcm", fcmAvailable = true, distributors = emptyList(), registered = true)

    @Test
    fun registeredNamesTheServersHost() {
        assertEquals("Registered with starbridge.run", pushState(registered, "https://starbridge.run"))
        assertEquals("Registered with sb.example.org", pushState(registered, "https://sb.example.org:8443/"))
        assertEquals("Not registered yet", pushState(registered.copy(registered = false), "https://starbridge.run"))
    }
}

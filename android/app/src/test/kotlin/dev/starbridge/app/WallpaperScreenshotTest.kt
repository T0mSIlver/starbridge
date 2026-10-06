package dev.starbridge.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.ui.Tab
import dev.starbridge.app.data.Colours
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.PromptActions
import dev.starbridge.app.ui.inbox.InboxScreen
import dev.starbridge.app.ui.quotas.QuotasScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

// The screens with the most roles under "Material You", on a warm, a cool and a low-chroma
// wallpaper, light and dark. Written to app/screenshots/wallpaper/.
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class WallpaperScreenshotTest(private val wallpaper: Wallpaper, private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0} dark={1}")
        fun cases() = Wallpaper.entries.flatMap { w -> listOf(arrayOf<Any>(w, false), arrayOf<Any>(w, true)) }

        init {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        }
    }

    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)

    private fun capture(name: String, content: @Composable () -> Unit) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark, colours = Colours.Wallpaper, dynamic = wallpaper.scheme(dark)) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { content() }
            }
        }
        val scheme = if (dark) "dark" else "light"
        // Images decode off the main thread: let them land before the capture.
        compose.waitForIdle()
        Thread.sleep(300)
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("screenshots/wallpaper/$name-${wallpaper.name.lowercase()}-$scheme.png")
    }

    @Test fun inbox() = capture("inbox") {
        Phone(Tab.Inbox, 4) { InboxScreen(fake.decisions, now, DecisionActions({ _, _, _ -> }, {}), prompts = fake.prompts, promptActions = PromptActions({ _, _, _, _ -> }), runs = fake.runs) }
    }

    // The mockup's "Material You" quotas, notifying on.
    @Config(qualifiers = "w412dp-h1060dp-xxhdpi")
    @Test fun quotas() = capture("quotas") { Phone(Tab.Quotas, 4) { QuotasScreen(fake.windows, now, settings = QuotaSettings(notify = listOf("claude"))) } }

    @Test fun devices() = capture("devices") { Phone(null, 0) { DevicesScreen(fake.members, now, DeviceActions({}, {}, {}, {}, {})) } }
}

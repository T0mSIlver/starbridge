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
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Colours
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.inbox.DecisionActions
import dev.starbridge.app.ui.inbox.DecisionScreen
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

// The screens with the most roles under "Match wallpaper", on a warm, a cool and a low-chroma
// wallpaper, light and dark. Written to app/screenshots/wallpaper/.
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-xxhdpi")
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
        compose.onRoot().captureRoboImage("screenshots/wallpaper/$name-${wallpaper.name.lowercase()}-$scheme.png")
    }

    @Test fun inbox() = capture("inbox") { InboxScreen(fake.decisions, now, DecisionActions({ _, _, _ -> }, {}), selected = fake.decisions[0].id) }

    @Test fun decision() = capture("decision") { DecisionScreen(fake.decisions[1], now, onAnswer = { _, _, _ -> }) }

    @Test fun quotas() = capture("quotas") { QuotasScreen(fake.windows, now) }

    @Config(qualifiers = "w411dp-h1500dp-xxhdpi")
    @Test fun devices() = capture("devices") {
        DevicesScreen(fake.members, Approval.Idle, fake.push, "https://starbridge.run", now, DeviceActions({}, {}, {}, {}, {}, {}, {}), colours = Colours.Wallpaper)
    }
}

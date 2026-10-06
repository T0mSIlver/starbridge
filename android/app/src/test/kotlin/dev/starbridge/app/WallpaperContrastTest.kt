package dev.starbridge.app

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import dev.starbridge.app.ui.theme.DarkColors
import dev.starbridge.app.ui.theme.DarkProviders
import dev.starbridge.app.ui.theme.LightColors
import dev.starbridge.app.ui.theme.LightProviders
import dev.starbridge.app.ui.theme.wallpaper
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Under "Material You" the grounds come from the wallpaper while amber, the quota states and
 * the provider dots stay fixed: each must still read on every wallpaper, light and dark. Text
 * needs 4.5:1 (WCAG AA), dots and marks 3:1. `fg3`, the hint tier, needs 3:1, as DESIGN.md's own
 * `fg3` reaches about 3.3:1 on its cards.
 */
class WallpaperContrastTest {
    private fun ratio(fg: Color, bg: Color): Double {
        val a = fg.compositeOver(bg).luminance() + 0.05
        val b = bg.luminance() + 0.05
        return (maxOf(a, b) / minOf(a, b)).toDouble()
    }

    @Test fun fixedAndDerivedColoursReadOnEveryWallpaper() {
        val failures = mutableListOf<String>()
        for (wallpaper in Wallpaper.entries) for (dark in listOf(false, true)) {
            val (c, m) = wallpaper(if (dark) DarkColors else LightColors, wallpaper.scheme(dark))
            val providers = if (dark) DarkProviders else LightProviders
            fun need(name: String, fg: Color, bg: Color, min: Double) {
                val r = ratio(fg, bg)
                if (r < min) failures += "$wallpaper ${if (dark) "dark" else "light"}: $name %.2f < $min".format(r)
            }
            // Cards are surfaceContainer, the ground surface, dialogs surfaceContainerHigh.
            for ((ground, bg) in listOf("card" to m.surfaceContainer, "ground" to m.surface)) {
                need("fg3 on $ground", c.fg3, bg, 3.0)
                need("ok on $ground", c.ok, bg, 4.5)
                need("warn on $ground", c.warn, bg, 4.5)
                need("bad on $ground", c.bad, bg, 4.5)
                need("accent on $ground", c.accent, bg, 3.0)
            }
            need("bad on dialog", c.bad, m.surfaceContainerHigh, 4.5)
            need("onAccent on accent", c.onAccent, c.accent, 4.5)
            for ((id, dot) in providers) need("$id dot on card", dot, m.surfaceContainer, 3.0)
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}

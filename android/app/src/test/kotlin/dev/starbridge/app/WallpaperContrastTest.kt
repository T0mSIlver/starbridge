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
 * needs 4.5:1 (WCAG AA), dots and marks 3:1. `fg3`, the hint tier, is text too: 4.5:1, as DESIGN.md's
 * own `fg3` reaches (#1939).
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
                need("fg3 on $ground", c.fg3, bg, 4.5)
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

    @Test fun starbridgeTokensKeepTheirContrast() {
        val failures = mutableListOf<String>()
        for ((scheme, c) in listOf("light" to LightColors, "dark" to DarkColors)) {
            for ((ground, bg) in listOf("bg" to c.bg, "surface" to c.surface, "surface2" to c.surface2)) {
                val hint = ratio(c.fg3, bg)
                if (hint < 4.5) failures += "$scheme: fg3 on $ground %.2f < 4.5".format(hint)
                val border = ratio(c.lineStrong, bg)
                if (border < 3.0) failures += "$scheme: lineStrong on $ground %.2f < 3".format(border)
                // Amber and red also read as text on their own tint over a ground (#2042).
                for ((name, fg, soft) in listOf(
                    Triple("accent", c.accent, c.accentSoft),
                    Triple("warn", c.warn, c.warnSoft),
                    Triple("bad", c.bad, c.badSoft),
                )) {
                    val onTint = ratio(fg, soft.compositeOver(bg))
                    if (onTint < 4.5) failures += "$scheme: $name on its tint over $ground %.2f < 4.5".format(onTint)
                }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}

package dev.starbridge.app

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import com.google.android.material.color.utilities.DynamicColor
import com.google.android.material.color.utilities.Hct
import com.google.android.material.color.utilities.MaterialDynamicColors
import com.google.android.material.color.utilities.SchemeTonalSpot

/**
 * Wallpapers that stand in for the phone's under "Match wallpaper": the colour Android would take
 * from each, turned into a scheme the way Android does by default (tonal spot).
 */
enum class Wallpaper(val seed: Int) {
    Warm(0xFFB5562B.toInt()),
    Cool(0xFF2B5D8C.toInt()),
    LowChroma(0xFF8A8478.toInt()),
    /** The mockups' "Match wallpaper" example. */
    Green(0xFF4E7A3C.toInt()),
    ;

    fun scheme(dark: Boolean): ColorScheme {
        val s = SchemeTonalSpot(Hct.fromInt(seed), dark, 0.0)
        val m = MaterialDynamicColors()
        fun c(role: DynamicColor) = Color(role.getArgb(s))
        val base = if (dark) darkColorScheme() else lightColorScheme()
        return base.copy(
            primary = c(m.primary()),
            onPrimary = c(m.onPrimary()),
            primaryContainer = c(m.primaryContainer()),
            onPrimaryContainer = c(m.onPrimaryContainer()),
            inversePrimary = c(m.inversePrimary()),
            secondary = c(m.secondary()),
            onSecondary = c(m.onSecondary()),
            secondaryContainer = c(m.secondaryContainer()),
            onSecondaryContainer = c(m.onSecondaryContainer()),
            tertiary = c(m.tertiary()),
            onTertiary = c(m.onTertiary()),
            tertiaryContainer = c(m.tertiaryContainer()),
            onTertiaryContainer = c(m.onTertiaryContainer()),
            background = c(m.background()),
            onBackground = c(m.onBackground()),
            surface = c(m.surface()),
            onSurface = c(m.onSurface()),
            surfaceVariant = c(m.surfaceVariant()),
            onSurfaceVariant = c(m.onSurfaceVariant()),
            surfaceTint = c(m.surfaceTint()),
            inverseSurface = c(m.inverseSurface()),
            inverseOnSurface = c(m.inverseOnSurface()),
            error = c(m.error()),
            onError = c(m.onError()),
            errorContainer = c(m.errorContainer()),
            onErrorContainer = c(m.onErrorContainer()),
            outline = c(m.outline()),
            outlineVariant = c(m.outlineVariant()),
            scrim = c(m.scrim()),
            surfaceBright = c(m.surfaceBright()),
            surfaceDim = c(m.surfaceDim()),
            surfaceContainer = c(m.surfaceContainer()),
            surfaceContainerHigh = c(m.surfaceContainerHigh()),
            surfaceContainerHighest = c(m.surfaceContainerHighest()),
            surfaceContainerLow = c(m.surfaceContainerLow()),
            surfaceContainerLowest = c(m.surfaceContainerLowest()),
        )
    }
}

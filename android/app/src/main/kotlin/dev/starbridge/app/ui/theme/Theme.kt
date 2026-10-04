package dev.starbridge.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import dev.starbridge.app.R

// Variable fonts: each weight is its own Font so the wght axis lands exactly.
private fun variable(res: Int, vararg weights: Int) = FontFamily(
    weights.map { Font(res, FontWeight(it), variationSettings = FontVariation.Settings(FontVariation.weight(it))) },
)

private val sans = variable(R.font.archivo, 400, 520, 600)
private val mono = variable(R.font.jetbrains_mono, 400, 500, 600)
private val faces = StarbridgeType(sans, mono)

private val LocalColors = staticCompositionLocalOf { DarkColors }

/** DESIGN.md's tokens; screens read these, not Material's roles. */
object StarbridgeTheme {
    val colors: StarbridgeColors
        @Composable @ReadOnlyComposable get() = LocalColors.current
    val type: StarbridgeType get() = faces
}

// Material's roles from the tokens, so stock components (buttons, the
// navigation bar, text fields) draw in the design's colours.
private fun scheme(c: StarbridgeColors, dark: Boolean): ColorScheme {
    val soft = c.accentSoft.compositeOver(c.surface)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.accent,
        onPrimary = c.onAccent,
        primaryContainer = soft,
        onPrimaryContainer = c.accentHi,
        secondary = c.fg2,
        onSecondary = c.bg,
        secondaryContainer = c.surface2,
        onSecondaryContainer = c.fg,
        tertiary = c.info,
        onTertiary = c.bg,
        tertiaryContainer = c.infoSoft.compositeOver(c.surface),
        onTertiaryContainer = c.info,
        background = c.bg,
        onBackground = c.fg,
        surface = c.bg,
        onSurface = c.fg,
        surfaceVariant = c.surface2,
        onSurfaceVariant = c.fg2,
        surfaceTint = c.accent,
        outline = c.lineStrong,
        outlineVariant = c.line,
        surfaceContainerLowest = c.bg,
        surfaceContainerLow = c.surface,
        surfaceContainer = c.surface,
        surfaceContainerHigh = c.surface2,
        surfaceContainerHighest = c.surface2,
        surfaceBright = c.surface2,
        surfaceDim = c.bg,
        error = c.bad,
        onError = c.bg,
        errorContainer = c.badSoft.compositeOver(c.surface),
        onErrorContainer = c.bad,
        scrim = c.scrim,
    )
}

private val typography = Typography(
    headlineMedium = faces.title,
    titleLarge = faces.heading,
    titleMedium = faces.question,
    bodyLarge = faces.body,
    bodyMedium = faces.body,
    bodySmall = faces.small,
    labelLarge = faces.action,
    labelMedium = faces.small,
    labelSmall = faces.label,
)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun StarbridgeTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) DarkColors else LightColors
    CompositionLocalProvider(LocalColors provides colors) {
        MaterialExpressiveTheme(
            colorScheme = scheme(colors, darkTheme),
            motionScheme = MotionScheme.expressive(),
            typography = typography,
            content = content,
        )
    }
}

package dev.starbridge.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import dev.starbridge.app.R
import dev.starbridge.app.data.Colours
import androidx.compose.ui.unit.sp

/**
 * Google Sans Flex is variable in weight and optical size. Android applies neither axis by
 * itself, so each style gets a family whose fonts set `wght` to the weight asked for and `opsz`
 * to the style's size, as Google's apps do: tighter at headline sizes, looser at body sizes.
 */
private fun flex(style: TextStyle): TextStyle {
    val size = style.fontSize.value
    val weights = listOf(400, 500, 600, 700) + (style.fontWeight?.weight ?: 400)
    val family = FontFamily(
        weights.distinct().map {
            Font(
                R.font.google_sans_flex,
                FontWeight(it),
                variationSettings = FontVariation.Settings(FontVariation.weight(it), FontVariation.Setting("opsz", size)),
            )
        },
    )
    // DESIGN.md gives tracking in em, Material in sp; text fields animate between the two, which
    // needs one unit.
    val tracking = style.letterSpacing.let { if (it.isEm) (it.value * size).sp else it }
    return style.copy(fontFamily = family, letterSpacing = tracking)
}

private fun family(res: Int, vararg weights: Int) = FontFamily(
    weights.map { Font(res, FontWeight(it), variationSettings = FontVariation.Settings(FontVariation.weight(it))) },
)

/** DESIGN.md's type roles: the generated styles, each with its own optical size. */
class StarbridgeFaces internal constructor(t: StarbridgeType) {
    val title = flex(t.title)
    val heading = flex(t.heading)
    val question = flex(t.question)
    val body = flex(t.body)
    val action = flex(t.action)
    val small = flex(t.small)
    val figure = flex(t.figure)
    val machine = flex(t.machine)
    val label = flex(t.label)
    val code = t.code
}

private val type = StarbridgeFaces(StarbridgeType(family(R.font.google_sans_flex, 400, 500, 600), family(R.font.google_sans_code, 400, 500)))

private val LocalColors = staticCompositionLocalOf { DarkColors }

/** DESIGN.md's tokens; screens read these for meaning (amber, quota states), Material's roles for the rest. */
object StarbridgeTheme {
    val colors: StarbridgeColors
        @Composable @ReadOnlyComposable get() = LocalColors.current
    val type: StarbridgeFaces get() = dev.starbridge.app.ui.theme.type
}

/**
 * Material's roles from the tokens, so stock components draw in Beacon. `primary` is the main
 * action of a screen at rest, so it is `fg`, never amber: amber only reaches a component when a
 * screen passes `accent` for what needs the owner.
 */
private fun scheme(c: StarbridgeColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.fg,
        onPrimary = c.bg,
        primaryContainer = c.surface2,
        onPrimaryContainer = c.fg,
        inversePrimary = c.bg,
        secondary = c.fg2,
        onSecondary = c.bg,
        secondaryContainer = c.surface2,
        onSecondaryContainer = c.fg,
        tertiary = c.info,
        onTertiary = c.bg,
        tertiaryContainer = c.infoSoft.compositeOver(c.surface),
        onTertiaryContainer = c.fg,
        background = c.bg,
        onBackground = c.fg,
        surface = c.bg,
        onSurface = c.fg,
        surfaceVariant = c.surface2,
        onSurfaceVariant = c.fg2,
        surfaceTint = c.fg,
        inverseSurface = c.fg,
        inverseOnSurface = c.bg,
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

/**
 * "Match wallpaper": Material You builds the scheme and the neutral tokens; the meaning colours
 * (`accent`, the quota and device states) stay DESIGN.md's, so amber still means "needs you".
 */
private fun wallpaper(c: StarbridgeColors, m: ColorScheme): Pair<StarbridgeColors, ColorScheme> = c.copy(
    bg = m.surface,
    surface = m.surfaceContainer,
    surface2 = m.surfaceContainerHighest,
    line = m.outlineVariant,
    lineStrong = m.outline,
    fg = m.onSurface,
    fg2 = m.onSurfaceVariant,
    fg3 = m.onSurfaceVariant.copy(alpha = 0.72f).compositeOver(m.surface),
) to m.copy(
    error = c.bad,
    onError = c.bg,
    errorContainer = c.badSoft.compositeOver(m.surfaceContainer),
    onErrorContainer = c.bad,
)

// Material's roles per DESIGN.md's table; the roles the design does not name keep Material's
// sizes in Google Sans Flex.
private val typography = Typography().let { m ->
    Typography(
        displayLarge = flex(m.displayLarge),
        displayMedium = flex(m.displayMedium),
        displaySmall = flex(m.displaySmall),
        headlineLarge = type.title,
        headlineMedium = type.figure.copy(fontFeatureSettings = null),
        headlineSmall = type.heading,
        titleLarge = type.question,
        titleMedium = type.action,
        titleSmall = flex(m.titleSmall),
        bodyLarge = type.body,
        bodyMedium = type.small,
        bodySmall = flex(m.bodySmall),
        labelLarge = type.label,
        labelMedium = flex(m.labelMedium),
        labelSmall = flex(m.labelSmall),
    )
}

// The Material 3 shape scale on DESIGN.md's radii.
private val shapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.xs),
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.lg),
    extraLarge = RoundedCornerShape(Radius.xl),
)

/** [colours] defaults to DESIGN.md's palette, which screenshots use so they stay stable. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun StarbridgeTheme(darkTheme: Boolean = isSystemInDarkTheme(), colours: Colours = Colours.Starbridge, content: @Composable () -> Unit) {
    val tokens = if (darkTheme) DarkColors else LightColors
    val (colors, scheme) = if (colours == Colours.Wallpaper) {
        val context = LocalContext.current
        wallpaper(tokens, if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context))
    } else {
        tokens to scheme(tokens, darkTheme)
    }
    CompositionLocalProvider(LocalColors provides colors) {
        MaterialExpressiveTheme(
            colorScheme = scheme,
            motionScheme = MotionScheme.expressive(),
            shapes = shapes,
            typography = typography,
            content = content,
        )
    }
}

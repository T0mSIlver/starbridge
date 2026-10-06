package dev.starbridge.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlin.math.roundToInt

/**
 * The mark drawn in the theme's colours: DESIGN.md's shapes, cropped to the visible 72 of the
 * 108-unit canvas (18 to 90), as the web's `Mark`. The climber is the only amber.
 */
@Composable
fun Mark(size: Dp, modifier: Modifier = Modifier) {
    val fg = MaterialTheme.colorScheme.onSurface
    val accent = StarbridgeTheme.colors.accent
    Canvas(modifier.size(size).clipToBounds()) {
        val k = this.size.width / 72f
        fun at(x: Float, y: Float) = Offset((x - 18f) * k, (y - 18f) * k)
        drawCircle(fg, radius = 80f * k, center = at(54f, 148f))
        drawRect(fg, topLeft = at(51.75f, 18f), size = Size(4.5f * k, 52f * k))
        drawRoundRect(accent, topLeft = at(48.5f, 34f), size = Size(11f * k, 20f * k), cornerRadius = CornerRadius(5.5f * k))
    }
}

/**
 * The mark and the name as one sign: "Starbridge" stands on the mark's ground line, its "g"
 * dropping below as a descender, with the web's gap of 0.4 of the mark between them.
 */
@Composable
fun Lockup(mark: Dp, name: TextUnit, modifier: Modifier = Modifier) {
    Row(modifier) {
        Mark(mark, Modifier.alignBy { it.measuredHeight })
        Spacer(Modifier.width((mark.value * 0.4f).roundToInt().dp))
        Text(
            "Starbridge",
            style = StarbridgeTheme.type.title.copy(fontSize = name, lineHeight = (name.value * 1.25f).sp),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            // At large font scales on a small phone the name shrinks rather than lose its end.
            autoSize = TextAutoSize.StepBased(maxFontSize = name),
            modifier = Modifier.alignByBaseline(),
        )
    }
}

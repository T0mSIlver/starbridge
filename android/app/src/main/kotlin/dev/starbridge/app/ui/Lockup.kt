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
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlin.math.roundToInt

/**
 * The mark drawn in the theme's colours: the arch and the amber dot of design/mark.svg
 * ([MarkShape]), in a square as wide as the arch whose bottom edge is the arch's feet, as the web's
 * `Mark`. The dot is the only amber.
 */
@Composable
fun Mark(size: Dp, modifier: Modifier = Modifier) {
    val fg = MaterialTheme.colorScheme.onSurface
    val accent = StarbridgeTheme.colors.accent
    val arch = remember { PathParser().parsePathString(MarkShape.ARCH).toPath() }
    Canvas(modifier.size(size).clipToBounds()) {
        withTransform({
            val k = this@Canvas.size.width / MarkShape.CROP_SIZE
            scale(scaleX = k, scaleY = k, pivot = Offset.Zero)
            translate(left = -MarkShape.CROP_X, top = -MarkShape.CROP_Y)
        }) {
            drawPath(arch, fg)
            drawCircle(accent, radius = MarkShape.DOT_R, center = Offset(MarkShape.DOT_X, MarkShape.DOT_Y))
        }
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

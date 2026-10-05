package dev.starbridge.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.starbridge.app.R

/**
 * Material Symbols Rounded, by codepoint. The bundled font is a subset of the variable font
 * (FILL, GRAD, opsz, wght) holding these glyphs only; adding one means adding it to the subset.
 */
enum class Sym(val code: Char) {
    Inbox(''), Speed(''), Settings(''), Terminal(''), Question(''),
    Check(''), More(''), Back(''), Phone(''), Laptop(''),
    Desktop(''), Server(''), Cloud(''), Bell(''), Drag(''),
    Chevron(''), ExpandMore(''), ExpandLess(''), Play(''), Qr(''),
    Lock(''), Filter(''), History(''), Key(''), Devices(''),
    Open(''), Waiting(''), Send(''), Link(''),
    Up(''), Down(''), CheckCircle(''), Computer(''), Close(''),
    Error(''), Copy(''), Visibility(''), Logout(''), Add(''), Pin(''),
}

/**
 * The symbols tuned to Google Sans Flex: weight 450, or 500 at 16 dp and below so small glyphs
 * hold their stroke; grade −25; optical size matched to the size drawn; filled when [filled]
 * (the selected tab, an active state).
 */
private fun settings(size: Dp, filled: Boolean) = FontVariation.Settings(
    FontVariation.Setting("FILL", if (filled) 1f else 0f),
    FontVariation.Setting("GRAD", -25f),
    FontVariation.Setting("opsz", size.value.coerceIn(20f, 48f)),
    FontVariation.weight(if (size <= 16.dp) 500 else 450),
)

/** One symbol, [size] square, whatever the font scale: icons size in dp, as Material's do. */
@Composable
fun Symbol(
    sym: Sym,
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
    filled: Boolean = false,
    tint: Color = LocalContentColor.current,
    contentDescription: String? = null,
) {
    val family = remember(size, filled) {
        FontFamily(Font(R.font.material_symbols_rounded, FontWeight(if (size <= 16.dp) 500 else 450), variationSettings = settings(size, filled)))
    }
    val px = with(LocalDensity.current) { size.toSp() }
    val label = contentDescription?.let { Modifier.semantics { this.contentDescription = it } } ?: Modifier
    Box(modifier.size(size).then(label), contentAlignment = Alignment.Center) {
        Text(
            sym.code.toString(),
            color = tint,
            style = TextStyle(
                fontFamily = family,
                fontSize = px,
                lineHeight = px,
                lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both),
            ),
        )
    }
}

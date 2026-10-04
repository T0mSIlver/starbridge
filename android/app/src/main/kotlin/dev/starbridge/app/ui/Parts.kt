package dev.starbridge.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

/** A screen's title. */
@Composable
fun Title(text: String, modifier: Modifier = Modifier) {
    Text(text, style = StarbridgeTheme.type.title, color = StarbridgeTheme.colors.fg, modifier = modifier.padding(top = Spacing.s6, bottom = Spacing.s2))
}

/** A section label or status pill text, as DESIGN.md's label role. */
@Composable
fun Label(text: String, modifier: Modifier = Modifier, color: Color = StarbridgeTheme.colors.fg3) {
    Text(text, style = StarbridgeTheme.type.label, color = color, modifier = modifier)
}

/** A card: surface on the ground, a line around it. */
@Composable
fun Panel(modifier: Modifier = Modifier, border: Color = StarbridgeTheme.colors.line, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(Radius.md),
        color = StarbridgeTheme.colors.surface,
        border = BorderStroke(1.dp, border),
    ) {
        Column(Modifier.padding(Spacing.s4), content = content)
    }
}

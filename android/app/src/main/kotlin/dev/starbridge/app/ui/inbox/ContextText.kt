package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.starbridge.app.protocol.Block
import dev.starbridge.app.protocol.Span
import dev.starbridge.app.protocol.parseContext
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme

/**
 * A decision's context in the subset every client renders (#969): one block per line, bullets
 * and numbers with a hanging indent, bold, links, and code inline or fenced, the only mono.
 */
@Composable
internal fun Context(text: String) {
    val scheme = MaterialTheme.colorScheme
    val blocks = remember(text) { parseContext(text) }
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        for (block in blocks) when (block) {
            is Block.Code -> Surface(shape = RoundedCornerShape(Spacing.s4), color = scheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
                Text(block.text, style = StarbridgeTheme.type.code, color = scheme.onSurface, modifier = Modifier.padding(horizontal = Spacing.s4, vertical = Spacing.s3))
            }
            is Block.Line -> Words(block.spans)
            // The marker hangs in a gutter, so wrapped lines align with the text.
            is Block.Item -> Row {
                Text(block.marker, style = StarbridgeTheme.type.body, color = scheme.onSurfaceVariant, modifier = Modifier.widthIn(min = 20.dp))
                Words(block.spans)
            }
        }
    }
}

@Composable
private fun Words(spans: List<Span>) {
    val scheme = MaterialTheme.colorScheme
    Text(annotated(spans, scheme.onSurface, scheme.surfaceContainerHighest), style = StarbridgeTheme.type.body, color = scheme.onSurfaceVariant)
}

private fun annotated(spans: List<Span>, strong: Color, codeBackground: Color): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.SemiBold else null,
            color = if (span.bold || span.href != null) strong else Color.Unspecified,
            fontFamily = if (span.code) StarbridgeTheme.type.code.fontFamily else null,
            fontSize = if (span.code) 14.sp else androidx.compose.ui.unit.TextUnit.Unspecified,
            background = if (span.code) codeBackground else Color.Unspecified,
        )
        val href = span.href
        if (href != null) {
            val link = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))
            withLink(LinkAnnotation.Url(href, link)) { withStyle(style) { append(span.text) } }
        } else withStyle(style) { append(span.text) }
    }
}

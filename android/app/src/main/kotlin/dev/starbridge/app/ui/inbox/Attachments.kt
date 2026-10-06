package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.data.label
import dev.starbridge.app.data.openLink
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import dev.starbridge.app.data.Image as Attached

/**
 * The decision's images, two to a row so a pair of mockups sits side by side, each at most
 * [maxHeight] tall. A lone image takes its own shape, so a phone screenshot is not a thumbnail in
 * an empty band; with [crop] it fills the card's width instead and shows its top. A tap opens it
 * full screen.
 */
@Composable
fun Images(images: List<Attached>, maxHeight: Dp, modifier: Modifier = Modifier, crop: Boolean = false) {
    if (images.isEmpty()) return
    var viewing by remember { mutableStateOf<Int?>(null) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        images.chunked(2).forEachIndexed { r, row ->
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                row.forEachIndexed { c, image ->
                    ImageBox(image, maxHeight, wide = crop || images.size > 1, crop = crop, Modifier.weight(1f)) { viewing = r * 2 + c }
                }
                // A lone image in a later row keeps the column width.
                if (images.size > 1 && row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
    viewing?.let { ImageViewer(images, it) { viewing = null } }
}

/**
 * One image, at most [maxHeight] tall: its own shape from the start, or [wide] across its column,
 * where [crop] fills it from the top and else the inset colour bands it.
 */
@Composable
private fun ImageBox(image: Attached, maxHeight: Dp, wide: Boolean, crop: Boolean, modifier: Modifier, onOpen: () -> Unit) {
    val edge = with(LocalDensity.current) { maxHeight.roundToPx() * 2 }
    // Decoded off the main thread, so a list of image decisions scrolls smoothly; the inset
    // colour shows until it lands.
    val bitmap by produceState<ImageBitmap?>(null, image.data, edge) {
        value = withContext(Dispatchers.Default) { image.bitmap(edge)?.asImageBitmap() }
    }
    BoxWithConstraints(modifier) {
        val natural = maxWidth * image.height / image.width
        val height = minOf(maxHeight, natural)
        val width = if (wide) maxWidth else minOf(maxWidth, height * image.width / image.height)
        Box(
            Modifier
                .size(width, height)
                .clip(RoundedCornerShape(Radius.lg))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                // No ripple: a finger that rests on the image before it drags the sheet would press
                // it, and the ripple starting and cancelling as the sheet moves is the one thing a
                // drag from the image did that one from the text did not (#246).
                .clickable(interactionSource = null, indication = null, onClickLabel = "View full screen", onClick = onOpen)
                // Labelled before the bitmap lands.
                .semantics { image.alt?.let { contentDescription = it } },
        ) {
            val loaded = bitmap
            if (loaded != null) {
                Image(
                    loaded,
                    contentDescription = null,
                    contentScale = if (crop) ContentScale.Crop else ContentScale.Fit,
                    alignment = if (crop) Alignment.TopCenter else Alignment.Center,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/**
 * Pages the agent wants the owner to see before answering, such as a Claude artifact, as chips
 * under "Attached by the agent" (#171): "Open" and the page's title, else its label.
 */
@Composable
fun Links(links: List<Link>, modifier: Modifier = Modifier) {
    if (links.isEmpty()) return
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Spacing.s1)) {
        Text("Attached by the agent", style = StarbridgeTheme.type.caption, color = scheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            links.forEach { link ->
                AssistChip(
                    onClick = { openLink(context, link.url) },
                    label = { Text(link.title?.let { "Open $it" } ?: link.label(), style = StarbridgeTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = { Symbol(Sym.Open, size = AssistChipDefaults.IconSize, tint = scheme.onSurfaceVariant) },
                    colors = AssistChipDefaults.assistChipColors(labelColor = scheme.onSurface),
                    border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = scheme.outline),
                )
            }
        }
    }
}

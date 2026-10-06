package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import dev.starbridge.app.R
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.data.githubRef
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
 * The decision's images, two to a row so a pair of mockups sits side by side, each row at most
 * [maxHeight] tall (see [ImageRow]); with [crop], each fills its half of the card, or the whole
 * card when alone, and shows its top. A tap opens it full screen.
 */
@Composable
fun Images(images: List<Attached>, maxHeight: Dp, modifier: Modifier = Modifier, crop: Boolean = false) {
    if (images.isEmpty()) return
    var viewing by remember { mutableStateOf<Int?>(null) }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val width = maxWidth
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            images.indices.chunked(2).forEach { row ->
                if (crop) {
                    val cell = if (images.size > 1) (width - Spacing.s2) / 2 else width
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                        row.forEach { i -> ImageBox(images[i], DpSize(cell, minOf(maxHeight, cell * images[i].height / images[i].width)), crop = true) { viewing = i } }
                    }
                } else {
                    ImageRow(row.map { images[it] }, width, maxHeight) { viewing = row[it] }
                }
            }
        }
    }
    viewing?.let { ImageViewer(images, it) { viewing = null } }
}

/**
 * A row of images at one height, each as wide as its shape asks, together filling [width] (#536):
 * none is banded or cropped, so a phone screenshot beside a desktop one is narrow, not boxed. The
 * row is at most [maxHeight] tall, and narrower when that caps it.
 */
@Composable
fun ImageRow(images: List<Attached>, width: Dp, maxHeight: Dp, onOpen: (Int) -> Unit) {
    val shape = images.sumOf { it.width.toDouble() / it.height }.toFloat()
    val height = minOf(maxHeight, (width - Spacing.s2 * (images.size - 1)) / shape)
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        images.forEachIndexed { i, image -> ImageBox(image, DpSize(height * image.width / image.height, height), crop = false) { onOpen(i) } }
    }
}

/**
 * A row of images over their options (#536): each in an equal column of [width], at its own shape,
 * no wider than its column and at most [maxHeight] tall, the row's images centred on one midline.
 */
@Composable
fun PickImages(images: List<Attached>, width: Dp, maxHeight: Dp, onOpen: (Int) -> Unit) {
    val column = (width - Spacing.s2) / 2
    val sizes = images.map { val h = minOf(maxHeight, column * it.height / it.width); DpSize(h * it.width / it.height, h) }
    val height = sizes.maxOf { it.height }
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        images.forEachIndexed { i, image ->
            Box(Modifier.size(column, height), contentAlignment = Alignment.Center) { ImageBox(image, sizes[i], crop = false) { onOpen(i) } }
        }
    }
}

/** One image at [size]: its own shape, or with [crop] filled from the top. */
@Composable
private fun ImageBox(image: Attached, size: DpSize, crop: Boolean, onOpen: () -> Unit) {
    val edge = with(LocalDensity.current) { maxOf(size.width, size.height).roundToPx() * 2 }
    // Decoded off the main thread, so a list of image decisions scrolls smoothly; the inset
    // colour shows until it lands.
    val bitmap by produceState<ImageBitmap?>(null, image.data, edge) {
        value = withContext(Dispatchers.Default) { image.bitmap(edge)?.asImageBitmap() }
    }
    Box(
        Modifier
            .size(size)
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
                contentScale = ContentScale.Crop,
                alignment = if (crop) Alignment.TopCenter else Alignment.Center,
                modifier = Modifier.fillMaxSize(),
            )
        }
        // Says the image opens full screen, since nothing else on a touch screen does (#170).
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(Spacing.s2)
                .size(Spacing.s8)
                .background(MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.72f), CircleShape)
                // The glyph is text; keep it out of the image's label.
                .clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            Symbol(Sym.Expand, size = Spacing.s5, tint = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/**
 * Pages the agent wants the owner to see before answering, such as a Claude artifact, as chips
 * under "Attached by the agent" (#171): "Open" and the page's title, else its label; a GitHub pull
 * request or issue leads with the GitHub mark.
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
                    label = { Text("Open ${link.label()}", style = StarbridgeTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = githubRef(link.url)?.let {
                        { Icon(painterResource(R.drawable.ic_github), contentDescription = null, Modifier.size(AssistChipDefaults.IconSize), tint = scheme.onSurfaceVariant) }
                    },
                    trailingIcon = { Symbol(Sym.Open, size = AssistChipDefaults.IconSize, tint = scheme.onSurfaceVariant) },
                    colors = AssistChipDefaults.assistChipColors(labelColor = scheme.onSurface),
                    border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = scheme.outline),
                )
            }
        }
    }
}

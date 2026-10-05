package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.data.label
import dev.starbridge.app.data.openLink
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import dev.starbridge.app.data.Image as Attached

/**
 * The decision's images, two to a row so a pair of mockups sits side by side, each at most
 * [maxHeight] tall and letterboxed on the inset colour.
 */
@Composable
fun Images(images: List<Attached>, maxHeight: Dp, modifier: Modifier = Modifier) {
    if (images.isEmpty()) return
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        images.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                row.forEach { ImageBox(it, maxHeight, Modifier.weight(1f)) }
                // A lone image in a later row keeps the column width.
                if (images.size > 1 && row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ImageBox(image: Attached, maxHeight: Dp, modifier: Modifier) {
    val edge = with(LocalDensity.current) { maxHeight.roundToPx() * 2 }
    // Decoded off the main thread, so a list of image decisions scrolls smoothly; the inset
    // colour shows until it lands.
    val bitmap by produceState<ImageBitmap?>(null, image.data, edge) {
        value = withContext(Dispatchers.Default) { image.bitmap(edge)?.asImageBitmap() }
    }
    BoxWithConstraints(modifier) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(minOf(maxHeight, maxWidth * image.height / image.width))
                .clip(RoundedCornerShape(Radius.lg))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            val loaded = bitmap
            if (loaded != null) {
                Image(loaded, contentDescription = image.alt, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

/** Pages the agent attached, such as a Claude artifact, as assist chips. */
@Composable
fun Links(links: List<Link>, modifier: Modifier = Modifier) {
    if (links.isEmpty()) return
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
        links.forEach { link ->
            AssistChip(
                onClick = { openLink(context, link.url) },
                label = { Text(link.label(), style = StarbridgeTheme.type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                leadingIcon = { Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(AssistChipDefaults.IconSize)) },
                colors = AssistChipDefaults.assistChipColors(labelColor = scheme.onSurface, leadingIconContentColor = scheme.onSurfaceVariant),
                border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = scheme.outline),
            )
        }
    }
}

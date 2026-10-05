package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import dev.starbridge.app.data.Image as Attached

/**
 * The images full screen on black, from [start]: pinch or double-tap to zoom, drag to look
 * around, swipe to the next one at full size. Back or the close button leave.
 */
@Composable
fun ImageViewer(images: List<Attached>, start: Int, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val pager = rememberPagerState(start) { images.size }
        var zoomed by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, userScrollEnabled = !zoomed, modifier = Modifier.fillMaxSize()) { page ->
                Zoomable(images[page], onZoom = { if (page == pager.currentPage) zoomed = it })
            }
            Box(Modifier.fillMaxSize().safeDrawingPadding().padding(Spacing.s2)) {
                FilledTonalIconButton(
                    onClick = onClose,
                    colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = Color.Black.copy(alpha = 0.6f), contentColor = Color.White),
                    modifier = Modifier.align(Alignment.TopStart),
                ) { Symbol(Sym.Close, contentDescription = "Close") }
                if (images.size > 1) {
                    Text(
                        "${pager.currentPage + 1} / ${images.size}",
                        style = StarbridgeTheme.type.label,
                        color = Color.White,
                        modifier = Modifier.align(Alignment.TopEnd).padding(Spacing.s3),
                    )
                }
            }
        }
    }
}

private const val MAX_SCALE = 6f
private const val DOUBLE_TAP_SCALE = 2.5f

/** Largest edge decoded for the viewer: past this a phone shows no more detail. */
private const val VIEW_EDGE = 4096

@Composable
private fun Zoomable(image: Attached, onZoom: (Boolean) -> Unit) {
    val bitmap by produceState<ImageBitmap?>(null, image.data) {
        value = withContext(Dispatchers.Default) { image.bitmap(VIEW_EDGE)?.asImageBitmap() }
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val (w, h) = with(LocalDensity.current) { maxWidth.toPx() to maxHeight.toPx() }
        // The fitted image's size, so a pan stops at its edges rather than the screen's.
        val fit = minOf(w / image.width, h / image.height)
        fun clamp(o: Offset, s: Float): Offset {
            val x = ((image.width * fit * s - w) / 2).coerceAtLeast(0f)
            val y = ((image.height * fit * s - h) / 2).coerceAtLeast(0f)
            return Offset(o.x.coerceIn(-x, x), o.y.coerceIn(-y, y))
        }
        fun set(s: Float, o: Offset) {
            scale = s.coerceIn(1f, MAX_SCALE)
            offset = clamp(o, scale)
            onZoom(scale > 1f)
        }
        val state = rememberTransformableState { zoom, pan, _ -> set(scale * zoom, offset + pan) }
        val loaded = bitmap
        if (loaded != null) {
            Image(
                loaded,
                contentDescription = image.alt,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(image.data) {
                        detectTapGestures(onDoubleTap = { at ->
                            if (scale > 1f) {
                                set(1f, Offset.Zero)
                            } else {
                                // Zoom on the tapped point: it stays under the finger.
                                val centre = Offset(w / 2, h / 2)
                                set(DOUBLE_TAP_SCALE, (centre - at) * (DOUBLE_TAP_SCALE - 1))
                            }
                        })
                    }
                    .transformable(state, canPan = { scale > 1f })
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
        }
    }
}

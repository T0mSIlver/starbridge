package dev.starbridge.app.ui.pairing

import android.content.Context
import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** [text] as a QR code: black modules on a white square, in light and dark themes alike. */
@Composable
fun QrImage(text: String, description: String, modifier: Modifier = Modifier) {
    val matrix = remember(text) {
        QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2))
    }
    Canvas(
        modifier
            .widthIn(max = 260.dp)
            .fillMaxWidth()
            .aspectRatio(1f)
            .background(Color.White, RoundedCornerShape(8.dp))
            .semantics { contentDescription = description },
    ) {
        val cell = size.width / matrix.width
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                if (matrix.get(x, y)) drawRect(Color.Black, Offset(x * cell, y * cell), Size(cell + 0.5f, cell + 0.5f))
            }
        }
    }
}

/**
 * Opens Google's code scanner, which runs in Play services and needs no camera permission, and
 * hands what it read to [onResult]. Phones without Play services type the code instead.
 */
@Composable
fun rememberScanner(onResult: (String) -> Unit, onError: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val result = rememberUpdatedState(onResult)
    val error = rememberUpdatedState(onError)
    return remember(context) { { scan(context, { result.value(it) }, { error.value(it) }) } }
}

private fun scan(context: Context, onResult: (String) -> Unit, onError: (String) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { barcode -> barcode.rawValue?.let(onResult) }
        .addOnFailureListener { e ->
            Log.w("Starbridge", "scan failed", e)
            onError("This phone cannot scan here. Type the code instead.")
        }
}

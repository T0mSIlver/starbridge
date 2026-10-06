package dev.starbridge.app

import android.graphics.Bitmap
import dev.starbridge.app.data.Image
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.protocol.toB64
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream

// A machine signs the size it declares; the decode must follow the image's own (#360).
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class ImagesTest {
    private fun png(edge: Int): String {
        val out = ByteArrayOutputStream()
        Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, out)
        return toB64(out.toByteArray())
    }

    @Test
    fun anImageLargerThanDeclaredIsRefused() {
        assertNull(Image(png(4096), 1, 1).bitmap(256))
    }

    @Test
    fun anImageIsSampledByItsRealSize() {
        val b = Image(png(4096), 4096, 4096).bitmap(256)
        assertNotNull(b)
        assertTrue("${b!!.width}", b.width < 512)
    }
}

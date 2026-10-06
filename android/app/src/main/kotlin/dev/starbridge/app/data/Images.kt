package dev.starbridge.app.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import dev.starbridge.app.protocol.fromB64

/** The longest edge an image may have, as the protocol bounds `width` and `height`. */
private const val MAX_IMAGE_EDGE = 8192

/** The most pixels a decode holds, 64 MB at 4 bytes each, whatever [bitmap]'s `maxEdge`. */
private const val MAX_PIXELS = 4096L * 4096

/**
 * The image decoded at most about [maxEdge] pixels on its longer side, so a notification or a
 * thumbnail never holds the full bitmap. Sampled by the image's real size, not the declared one,
 * which a machine could understate (#360). Null when it does not decode, or is larger than declared.
 */
fun Image.bitmap(maxEdge: Int): Bitmap? = try {
    val bytes = fromB64(data)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val (w, h) = bounds.outWidth to bounds.outHeight
    if (w <= 0 || h <= 0 || w > width || h > height || maxOf(w, h) > MAX_IMAGE_EDGE) {
        null
    } else {
        var sample = 1
        while (maxOf(w, h) / (sample * 2) >= maxEdge || (w / sample).toLong() * (h / sample) > MAX_PIXELS) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
} catch (_: Exception) {
    null
} catch (_: OutOfMemoryError) {
    null
}

/** A link's chip text: its title, else "Claude artifact" for one, else its host and path. */
fun Link.label(): String {
    title?.let { return it }
    val uri = Uri.parse(url)
    val path = uri.path.orEmpty()
    if (uri.host == "claude.ai" && ARTIFACT_PATH.containsMatchIn(path)) return "Claude artifact"
    val text = uri.host.orEmpty().removePrefix("www.") + if (path == "/") "" else path
    return if (text.length > 40) text.take(39) + "…" else text
}

/** Where the owner answers a decision with `answerIn`: "the artifact" for a Claude one. */
fun Link.place() = title ?: if (label() == "Claude artifact") "the artifact" else label()

private val ARTIFACT_PATH = Regex("/artifacts?/")

private const val CLAUDE_APP = "com.anthropic.claude"

/** A Claude artifact's page, which the Claude app shows only in its in-app browser. */
private fun isArtifact(uri: Uri) = uri.host == "claude.ai" && ARTIFACT_PATH.containsMatchIn(uri.path.orEmpty())

/**
 * The intent that opens [url] outside the Claude app: an artifact goes to the browser, since the
 * Claude app, which claims claude.ai links, shows it only in its in-app browser (#171).
 */
fun browserIntent(url: String): Intent {
    val uri = Uri.parse(url)
    val view = Intent(Intent.ACTION_VIEW, uri)
    // A selector with no host matches browsers only, not apps that claim one domain.
    if (isArtifact(uri)) view.selector = Intent(Intent.ACTION_VIEW, Uri.parse("https:")).addCategory(Intent.CATEGORY_BROWSABLE)
    return view
}

/** Opens a link: a claude.ai session in the Claude app when it is installed and takes it, else [browserIntent]. */
fun openLink(context: Context, url: String) {
    val uri = Uri.parse(url)
    if (uri.host == "claude.ai" && !isArtifact(uri)) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage(CLAUDE_APP))
            return
        } catch (_: ActivityNotFoundException) {
            // Not installed, or it does not open this kind of link.
        }
    }
    runCatching { context.startActivity(browserIntent(url)) }
        .recoverCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
}

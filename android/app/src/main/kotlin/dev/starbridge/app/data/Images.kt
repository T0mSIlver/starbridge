package dev.starbridge.app.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import dev.starbridge.app.protocol.LinkIcon
import dev.starbridge.app.protocol.fromB64
import dev.starbridge.app.protocol.linkChip

/** Where [Image.file]s are read from: the app's [Disk], set by the store as it loads (#1471). */
object ImageFiles {
    @Volatile var read: (String) -> ByteArray? = { null }
}

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
    val bytes = file?.let { ImageFiles.read(it) ?: return null } ?: fromB64(data)
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

/** A link's chip text, from the rule every client shares (protocol/LinkChip.kt, #1577). */
fun Link.label(project: String = ""): String = linkChip(url, title, project).label

/** Where the owner answers a decision with `answerIn`: "the artifact" for a Claude one. */
fun Link.place(): String {
    // The chip's text: the agent's title only on GitHub and a Claude artifact, as web's answerPlace.
    val chip = linkChip(url, title)
    return if (chip.icon == LinkIcon.Artifact && chip.label == "Claude artifact") "the artifact" else chip.label
}

private const val CLAUDE_APP = "com.anthropic.claude"

/** A Claude artifact's page, which the Claude app shows only in its in-app browser. */
private fun isArtifact(uri: Uri) = uri.host == "claude.ai" && ARTIFACT_PATH.containsMatchIn(uri.path.orEmpty())

private val ARTIFACT_PATH = Regex("/artifacts?/")

/**
 * The intent that opens [url] outside the Claude app: an artifact goes to the browser, since the
 * Claude app, which claims claude.ai links, shows it only in its in-app browser (#171).
 */
fun browserIntent(url: String): Intent {
    val uri = Uri.parse(url)
    return if (isArtifact(uri)) inBrowser(uri) else Intent(Intent.ACTION_VIEW, uri)
}

/** The intent that opens [uri] in a browser, even when an app, this one included, claims its host. */
fun inBrowser(uri: Uri): Intent = Intent(Intent.ACTION_VIEW, uri).apply {
    // A selector with no host matches browsers only, not apps that claim one domain.
    selector = Intent(Intent.ACTION_VIEW, Uri.parse("https:")).addCategory(Intent.CATEGORY_BROWSABLE)
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

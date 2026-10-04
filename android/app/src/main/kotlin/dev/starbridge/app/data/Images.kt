package dev.starbridge.app.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import dev.starbridge.app.protocol.fromB64

/**
 * The image decoded at most about [maxEdge] pixels on its longer side, so a notification or a
 * thumbnail never holds the full bitmap. Null when it does not decode.
 */
fun Image.bitmap(maxEdge: Int): Bitmap? = runCatching {
    val bytes = fromB64(data)
    var sample = 1
    while (maxOf(width, height) / (sample * 2) >= maxEdge) sample *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}.getOrNull()

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

/** Opens a link: claude.ai in the Claude app when it is installed and takes it, else a browser. */
fun openLink(context: Context, url: String) {
    val view = Intent(Intent.ACTION_VIEW, Uri.parse(url))
    if (Uri.parse(url).host == "claude.ai") {
        try {
            context.startActivity(Intent(view).setPackage(CLAUDE_APP))
            return
        } catch (_: ActivityNotFoundException) {
            // Not installed, or it does not open this kind of link.
        }
    }
    runCatching { context.startActivity(view) }
}

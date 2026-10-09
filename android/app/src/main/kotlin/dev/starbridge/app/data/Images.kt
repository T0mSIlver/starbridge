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

/**
 * A link's chip text, as on the web (#971). A GitHub pull request, issue or discussion reads
 * "#123", a release its tag, a commit its short hash, led by the repo when it isn't [project], the
 * session's; any other link reads as its title, else "Actions run" for a run, "Claude artifact" for
 * one, else its host and path (a GitHub page's path alone, since its mark says GitHub).
 */
fun Link.label(project: String = ""): String {
    val gh = githubLink(url)
    gh?.ref?.let { ref ->
        if (gh.repo.equals(project, ignoreCase = true)) return clip(ref)
        return clip(gh.repo + (if (ref.startsWith("#")) "" else " ") + ref)
    }
    title?.let { return it }
    if (gh?.kind == GitHubKind.Run) return "Actions run"
    if (gh != null) return clip(gh.path.ifEmpty { "GitHub" })
    val uri = Uri.parse(url)
    val path = uri.path.orEmpty()
    if (uri.host == "claude.ai" && ARTIFACT_PATH.containsMatchIn(path)) return "Claude artifact"
    return clip(uri.host.orEmpty().removePrefix("www.") + if (path == "/") "" else path)
}

private fun clip(text: String) = if (text.length > 40) text.take(39) + "…" else text

/** Where the owner answers a decision with `answerIn`: "the artifact" for a Claude one. */
fun Link.place() = title ?: if (label() == "Claude artifact") "the artifact" else label()

private val ARTIFACT_PATH = Regex("/artifacts?/")

/** What a GitHub link points at: each kind has its Octicon on the chip (#971). */
enum class GitHubKind { Pull, Issue, Discussion, Run, Release, Commit, Other }

/** [ref] is "#123", a release's tag or a commit's short hash; [path] the path after github.com. */
data class GitHubLink(val kind: GitHubKind, val repo: String, val ref: String?, val path: String)

/** What a github.com link points at, else null. */
fun githubLink(url: String): GitHubLink? {
    val uri = Uri.parse(url)
    if (uri.scheme != "https" || uri.host?.lowercase() !in setOf("github.com", "www.github.com")) return null
    val path = uri.path.orEmpty().trimEnd('/')
    val parts = path.split("/")
    val owner = parts.getOrNull(1).orEmpty()
    val name = parts.getOrNull(2).orEmpty()
    val other = GitHubLink(GitHubKind.Other, if (owner.isNotEmpty() && name.isNotEmpty()) name else "", null, path.removePrefix("/"))
    if (other.repo.isEmpty()) return other
    val section = parts.getOrNull(3)
    val a = parts.getOrNull(4).orEmpty()
    val b = parts.getOrNull(5).orEmpty()
    fun number(kind: GitHubKind) = if (DIGITS.matches(a)) other.copy(kind = kind, ref = "#$a") else other
    return when {
        section == "pull" -> number(GitHubKind.Pull)
        section == "issues" -> number(GitHubKind.Issue)
        section == "discussions" -> number(GitHubKind.Discussion)
        section == "actions" && a == "runs" && DIGITS.matches(b) -> other.copy(kind = GitHubKind.Run)
        section == "releases" && a == "tag" && b.isNotEmpty() -> other.copy(kind = GitHubKind.Release, ref = b)
        section == "commit" && SHA.matches(a) -> other.copy(kind = GitHubKind.Commit, ref = a.take(7))
        else -> other
    }
}

private val DIGITS = Regex("\\d+")
private val SHA = Regex("[0-9a-fA-F]{7,40}")

private const val CLAUDE_APP = "com.anthropic.claude"

/** A Claude artifact's page, which the Claude app shows only in its in-app browser. */
private fun isArtifact(uri: Uri) = uri.host == "claude.ai" && ARTIFACT_PATH.containsMatchIn(uri.path.orEmpty())

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

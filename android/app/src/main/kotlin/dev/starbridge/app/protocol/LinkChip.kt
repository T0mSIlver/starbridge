package dev.starbridge.app.protocol

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * What a link chip shows (spec/items.md, "Links"): the port of packages/protocol's links.ts, which
 * vectors/links.json keeps in step. A link that matches no rule exactly keeps the plain chip: no
 * icon, its title then its host, else its host and path. Nothing here fetches the URL.
 */
enum class LinkIcon { Pull, Issue, Discussion, Run, Release, Commit, File, GitHub, Artifact }

data class LinkChip(val icon: LinkIcon?, val label: String)

/**
 * A link's chip (#971, #1577). A GitHub pull request, issue or discussion reads "#123", a release
 * its tag, a commit its short hash, each led by the repo when it isn't [project], the session's;
 * the icon says what the number is, so the agent's title gives way. Another GitHub page and a
 * Claude artifact read as the agent's title, else a GitHub file its name, a run "Actions run",
 * another GitHub page its path, an artifact "Claude artifact". Any other host shows its host and
 * path, never the agent's title: only those two sites, whose icons name them, get a chip in the
 * agent's words, so no title dresses another site as one of them (#1722, #2203). A title with
 * hidden or reordering characters counts as none. A link that can't be read shows as written.
 */
fun linkChip(url: String, title: String?, project: String = ""): LinkChip {
    val parts = parseUrl(url) ?: return LinkChip(null, clip(url))
    val gh = if (parts.host in GITHUB_HOSTS) github(parts.path) else null
    if (gh?.ref != null) {
        val same = asciiLower(gh.repo) == asciiLower(project)
        val sep = if (gh.ref.startsWith("#")) "" else " "
        return LinkChip(gh.icon, clip(if (same) gh.ref else gh.repo + sep + gh.ref))
    }
    val shown = title?.takeIf { it.isNotEmpty() && !hidden(it) }
    if (gh != null) return LinkChip(gh.icon, shown ?: clip(gh.text))
    val host = parts.host.removePrefix("www.")
    if (parts.host == "claude.ai" && ARTIFACT.matches(parts.path)) return LinkChip(LinkIcon.Artifact, shown ?: "Claude artifact")
    return LinkChip(null, clip(host + if (parts.path == "/") "" else parts.path))
}

private val GITHUB_HOSTS = setOf("github.com", "www.github.com")
// claude.ai/artifact/<id>, /code/artifact/<id> and the shared /public/artifacts/<id>.
private val ARTIFACT = Regex("/(artifact|code/artifact|public/artifacts)/[A-Za-z0-9_-]{1,64}/?")
private val HOST = Regex("[A-Za-z0-9.-]+")

private class Parts(val host: String, val path: String)

/**
 * The host (lowercase) and path of an https URL, read by hand as links.ts does rather than by
 * [android.net.Uri], which disagrees at the edges. An authority with anything but letters,
 * digits, dots and hyphens (a user, a port, a backslash) gives null: the URL shows as written.
 */
private fun parseUrl(url: String): Parts? {
    if (!url.startsWith("https://") || '\\' in url) return null
    val rest = url.removePrefix("https://")
    val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
    val host = if (end < 0) rest else rest.substring(0, end)
    if (!HOST.matches(host)) return null
    val tail = if (end < 0) "" else rest.substring(end)
    val path = tail.split('?', '#').first()
    // A "." or ".." segment, even percent-encoded, makes the browser open another page than the
    // path reads: show the URL as written.
    if (path.split('/').any { DOTS.matches(it) }) return null
    return Parts(asciiLower(host), path.ifEmpty { "/" })
}

private val DOTS = Regex("(\\.|%2[eE]){1,2}")

/** ASCII letters lowercased, the same in every port; GitHub's names are ASCII. */
private fun asciiLower(text: String) = buildString { text.forEach { append(if (it in 'A'..'Z') it + 32 else it) } }

private class GitHub(val icon: LinkIcon, val repo: String, val ref: String?, val text: String)

/** What a github.com path points at; [GitHub.text] is the label for a page with no ref. */
private fun github(path: String): GitHub {
    val trimmed = path.trimEnd('/')
    val segments = trimmed.split("/")
    fun at(i: Int) = segments.getOrNull(i).orEmpty()
    val (owner, name, section, a, b) = listOf(at(1), at(2), at(3), at(4), at(5))
    val repo = if (owner.isNotEmpty() && name.isNotEmpty()) name else ""
    val other = GitHub(LinkIcon.GitHub, repo, null, trimmed.removePrefix("/").ifEmpty { "GitHub" })
    if (repo.isEmpty()) return other
    fun number(icon: LinkIcon) = if (DIGITS.matches(a)) GitHub(icon, repo, "#$a", other.text) else other
    val file = segments.last()
    return when {
        section == "pull" -> number(LinkIcon.Pull)
        section == "issues" -> number(LinkIcon.Issue)
        section == "discussions" -> number(LinkIcon.Discussion)
        section == "actions" && a == "runs" && DIGITS.matches(b) -> GitHub(LinkIcon.Run, repo, null, "Actions run")
        section == "releases" && a == "tag" && b.isNotEmpty() -> GitHub(LinkIcon.Release, repo, decode(b), other.text)
        section == "commit" && SHA.matches(a) -> GitHub(LinkIcon.Commit, repo, asciiLower(a.take(7)), other.text)
        // /blob/<ref>/<path>: a branch may hold slashes, but the last segment is always the file.
        section == "blob" && a.isNotEmpty() && segments.size > 5 && file.isNotEmpty() -> GitHub(LinkIcon.File, repo, null, decode(file))
        else -> other
    }
}

private val DIGITS = Regex("[0-9]{1,20}")
private val SHA = Regex("[0-9a-fA-F]{7,40}")

// Characters that would hide or reorder what a chip says: controls, bidi marks and the rest of
// Unicode's default-ignorable code points (soft hyphen, zero-width, variation selectors, tags).
private val HIDDEN = listOf(
    0x0..0x1f, 0x7f..0x9f, 0xad..0xad, 0x34f..0x34f, 0x61c..0x61c, 0x115f..0x1160, 0x17b4..0x17b5, 0x180b..0x180f,
    0x200b..0x200f, 0x202a..0x202e, 0x2060..0x206f, 0x3164..0x3164, 0xfe00..0xfe0f, 0xfeff..0xfeff, 0xffa0..0xffa0,
    0xfff0..0xfffb, 0x1bca0..0x1bca3, 0x1d173..0x1d17a, 0xe0000..0xe0fff,
)

private fun hidden(text: String) = text.codePoints().anyMatch { p -> HIDDEN.any { p in it } }

/**
 * A percent-decoded segment, as JavaScript's decodeURIComponent reads it (a "+" stays a "+"),
 * else the segment as written when it is malformed or decodes to a character that would hide or
 * reorder the chip's text.
 */
private fun decode(segment: String): String {
    val bytes = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < segment.length) {
        if (segment[i] == '%') {
            if (i + 2 >= segment.length) return segment
            val hi = hex(segment[i + 1])
            val lo = hex(segment[i + 2])
            if (hi < 0 || lo < 0) return segment
            bytes.write((hi shl 4) or lo)
            i += 3
        } else {
            val end = i + Character.charCount(segment.codePointAt(i))
            bytes.write(segment.substring(i, end).toByteArray(Charsets.UTF_8))
            i = end
        }
    }
    val text = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (_: CharacterCodingException) {
        return segment
    }
    return if (hidden(text)) segment else text
}

/** An ASCII hex digit's value, else -1; [Character.digit] would take other scripts' digits. */
private fun hex(c: Char) = when (c) {
    in '0'..'9' -> c - '0'
    in 'a'..'f' -> c - 'a' + 10
    in 'A'..'F' -> c - 'A' + 10
    else -> -1
}

/** At most 40 code points, the 40th an ellipsis when cut; never half a surrogate pair. */
private fun clip(text: String, max: Int = 40): String =
    if (text.codePointCount(0, text.length) > max) text.substring(0, text.offsetByCodePoints(0, max - 1)) + "…" else text

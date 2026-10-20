package dev.starbridge.app.protocol

/**
 * A decision's context as every client shows it (#969): the port of packages/protocol's
 * context.ts, which vectors/context.json keeps in step. Anything outside the subset shows as typed.
 */
data class Span(val text: String, val code: Boolean = false, val bold: Boolean = false, val href: String? = null)

/** One line of the context, or one fenced code block; [Item] is a bullet or a numbered line. */
sealed interface Block {
    data class Line(val spans: List<Span>) : Block
    data class Item(val marker: String, val spans: List<Span>) : Block
    data class Code(val text: String) : Block
}

// JavaScript's \s, spelled out: Android's ICU regex rejects the UNICODE_CHARACTER_CLASS flag
// that would widen Java's \s to it, and fails the whole pattern (#1002). Typed codes strip it too (#1145).
internal const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

// Leftmost match wins; at one position, code before a link before bold before a bare URL.
private val INLINE = Regex(
    "`([^`\\n]+)`|\\[([^\\]\\n]+)\\]\\((https://[^$WS)]+)\\)|\\*\\*(?=[^$WS])([^\\n]*?[^$WS])\\*\\*|(https://[^$WS<>]+)",
)
// JavaScript's `.`: anything but its four line terminators; Java's also stops at U+0085.
private const val DOT = "[^\\n\\r\\u2028\\u2029]"
private fun isJsSpace(c: Char) = c in "\t\n\u000B\u000C\r \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF" || c in '\u2000'..'\u200A'
private val URL_TAIL = Regex("[.,;:!?'\")\\]]+$")
private val BULLET = Regex("^[-*•][$WS]+($DOT*)$")
private val NUMBER = Regex("^([0-9]{1,3})[.)][$WS]+($DOT*)$")
private val HEADING = Regex("^#{1,6}[$WS]+($DOT*)$")

private fun inline(text: String, bold: Boolean = false): List<Span> {
    val spans = mutableListOf<Span>()
    fun push(span: Span) {
        if (span.text.isEmpty()) return
        val s = if (bold) span.copy(bold = true) else span
        val last = spans.lastOrNull()
        if (last != null && !s.code && s.href == null && !last.code && last.href == null && last.bold == s.bold) {
            spans[spans.size - 1] = last.copy(text = last.text + s.text)
        } else spans += s
    }
    var at = 0
    var m = INLINE.find(text, 0)
    while (m != null) {
        val start = m.range.first
        var end = m.range.last + 1
        push(Span(text.substring(at, start)))
        val g = m.groups
        when {
            g[1] != null -> push(Span(g[1]!!.value, code = true))
            // The agent's words show only where a link chip would: on GitHub and a Claude artifact.
            g[2] != null && g[3] != null -> push(Span(linkChip(g[3]!!.value, g[2]!!.value).label, href = g[3]!!.value))
            g[4] != null -> inline(g[4]!!.value, bold = true).forEach(::push)
            else -> {
                val url = m.value.replace(URL_TAIL, "")
                end = start + url.length
                push(Span(url.replaceFirst(Regex("^https://"), ""), href = url))
            }
        }
        // A trimmed tail goes back to the text after it.
        at = end
        m = if (end < text.length) INLINE.find(text, end) else null
    }
    push(Span(text.substring(at)))
    return spans
}

/** Fences open and close on a line starting with ```; an unclosed one runs to the end. */
fun parseContext(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    var code: MutableList<String>? = null
    fun close() {
        val body = code?.joinToString("\n")?.trimEnd(::isJsSpace).orEmpty()
        if (body.isNotEmpty()) blocks += Block.Code(body)
        code = null
    }
    for (raw in text.replace(Regex("\r\n?"), "\n").split("\n")) {
        if (raw.trimStart(::isJsSpace).startsWith("```")) {
            if (code != null) close() else code = mutableListOf()
            continue
        }
        code?.let {
            it += raw
            continue
        }
        // JavaScript's trim, not Kotlin's: they disagree on U+FEFF and U+001C to U+001F.
        val line = raw.trim(::isJsSpace)
        if (line.isEmpty()) continue
        val b = BULLET.find(line)
        val n = NUMBER.find(line)
        val h = HEADING.find(line)
        blocks += when {
            b != null -> Block.Item("•", inline(b.groupValues[1]))
            n != null -> Block.Item("${n.groupValues[1]}.", inline(n.groupValues[2]))
            // A heading is a bold line: a card has no room for sizes.
            h != null -> Block.Line(inline(h.groupValues[1], bold = true))
            else -> Block.Line(inline(line))
        }
    }
    close()
    return blocks
}

/** The context as plain lines, for a notification's text where spans are not wanted. */
fun contextText(text: String): String = parseContext(text).joinToString("\n") { b ->
    when (b) {
        is Block.Code -> b.text
        is Block.Item -> "${b.marker} ${b.spans.joinToString("") { it.text }}"
        is Block.Line -> b.spans.joinToString("") { it.text }
    }
}

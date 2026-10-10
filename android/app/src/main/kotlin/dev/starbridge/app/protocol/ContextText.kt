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

// (?U): JavaScript's \s takes Unicode spaces too. Leftmost match wins; at one position, code
// before a link before bold before a bare URL.
private val INLINE = Regex(
    "(?U)`([^`\\n]+)`|\\[([^\\]\\n]+)\\]\\((https?://[^\\s)]+)\\)|\\*\\*(?=\\S)([^\\n]*?\\S)\\*\\*|(https?://[^\\s<>]+)",
)
private val URL_TAIL = Regex("[.,;:!?'\")\\]]+$")
private val BULLET = Regex("(?U)^[-*•]\\s+(.*)$")
private val NUMBER = Regex("(?U)^([0-9]{1,3})[.)]\\s+(.*)$")
private val HEADING = Regex("(?U)^#{1,6}\\s+(.*)$")

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
            g[2] != null && g[3] != null -> push(Span(g[2]!!.value, href = g[3]!!.value))
            g[4] != null -> inline(g[4]!!.value, bold = true).forEach(::push)
            else -> {
                val url = m.value.replace(URL_TAIL, "")
                end = start + url.length
                push(Span(url.replaceFirst(Regex("^https?://"), ""), href = url))
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
        val body = code?.joinToString("\n")?.trimEnd().orEmpty()
        if (body.isNotEmpty()) blocks += Block.Code(body)
        code = null
    }
    for (raw in text.replace(Regex("\r\n?"), "\n").split("\n")) {
        if (raw.trimStart().startsWith("```")) {
            if (code != null) close() else code = mutableListOf()
            continue
        }
        code?.let {
            it += raw
            continue
        }
        val line = raw.trim()
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

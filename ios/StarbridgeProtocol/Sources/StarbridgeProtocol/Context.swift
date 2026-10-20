// A decision's context as every client shows it (#969): the port of packages/protocol's
// context.ts, which vectors/context.json keeps in step. Anything outside the subset shows as
// typed. The TypeScript uses regular expressions; this scans Unicode scalars by hand, since
// Swift's Regex matches grapheme clusters, which JavaScript's do not.

/** A run of text with one style: code, bold, a link, or plain. Bold may wrap code or a link. */
public struct Span: Equatable, Sendable {
    public var text: String
    public var code: Bool
    public var bold: Bool
    public var href: String?

    public init(_ text: String, code: Bool = false, bold: Bool = false, href: String? = nil) {
        self.text = text
        self.code = code
        self.bold = bold
        self.href = href
    }
}

/** One line of the context, or one fenced code block. */
public enum Block: Equatable, Sendable {
    case line([Span])
    /** "•" for a bullet, "3." for a numbered line. */
    case item(marker: String, spans: [Span])
    case code(String)
}

/** JavaScript's \s. */
private func isSpace(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
}

/** What JavaScript's `.` does not match. */
private func isLineTerminator(_ u: Unicode.Scalar) -> Bool {
    u == "\n" || u == "\r" || u == "\u{2028}" || u == "\u{2029}"
}

private typealias Scalars = [Unicode.Scalar]

private func string(_ s: ArraySlice<Unicode.Scalar>) -> String {
    var v = String.UnicodeScalarView()
    v.append(contentsOf: s)
    return String(v)
}

private func trimmed(_ s: Scalars) -> ArraySlice<Unicode.Scalar> {
    var a = s.startIndex, b = s.endIndex
    while a < b, isSpace(s[a]) { a += 1 }
    while b > a, isSpace(s[b - 1]) { b -= 1 }
    return s[a..<b]
}

private func hasPrefix(_ s: Scalars, _ at: Int, _ p: String) -> Bool {
    let ps = Array(p.unicodeScalars)
    return at + ps.count <= s.count && Array(s[at..<at + ps.count]) == ps
}

/** "http://" or "https://" at `at`: its length, or nil. */
private func scheme(_ s: Scalars, _ at: Int) -> Int? {
    // https only, as link chips are.
    hasPrefix(s, at, "https://") ? 8 : nil
}

private enum Inline {
    case code(String)
    case link(String, href: String)
    case bold(String)
    case url(String)
}

/**
 * The inline match at `i`, if one starts there, and where it ends. At one position: code before a
 * link before bold before a bare URL.
 */
private func match(_ s: Scalars, _ i: Int) -> (Inline, Int)? {
    // `([^`\n]+)`
    if s[i] == "`" {
        var j = i + 1
        while j < s.count, s[j] != "`", s[j] != "\n" { j += 1 }
        if j > i + 1, j < s.count, s[j] == "`" { return (.code(string(s[i + 1..<j])), j + 1) }
    }
    // \[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)
    if s[i] == "[" {
        var j = i + 1
        while j < s.count, s[j] != "]", s[j] != "\n" { j += 1 }
        if j > i + 1, j + 1 < s.count, s[j] == "]", s[j + 1] == "(", let n = scheme(s, j + 2) {
            let u = j + 2
            var k = u + n
            while k < s.count, !isSpace(s[k]), s[k] != ")" { k += 1 }
            if k > u + n, k < s.count, s[k] == ")" { return (.link(string(s[i + 1..<j]), href: string(s[u..<k])), k + 1) }
        }
    }
    // \*\*(?=\S)([^\n]*?\S)\*\*
    if hasPrefix(s, i, "**"), i + 2 < s.count, !isSpace(s[i + 2]) {
        var k = i + 2
        while k < s.count, s[k] != "\n" {
            if !isSpace(s[k]), hasPrefix(s, k + 1, "**") { return (.bold(string(s[i + 2...k])), k + 3) }
            k += 1
        }
    }
    // https:\/\/[^\s<>]+
    if let n = scheme(s, i) {
        var k = i + n
        while k < s.count, !isSpace(s[k]), s[k] != "<", s[k] != ">" { k += 1 }
        if k > i + n { return (.url(string(s[i..<k])), k) }
    }
    return nil
}

private func inline(_ text: String, bold: Bool = false) -> [Span] {
    var spans: [Span] = []
    func push(_ span: Span) {
        if span.text.isEmpty { return }
        var s = span
        if bold { s.bold = true }
        if let last = spans.last, !s.code, s.href == nil, !last.code, last.href == nil, last.bold == s.bold {
            spans[spans.count - 1].text += s.text
        } else {
            spans.append(s)
        }
    }
    let s = Array(text.unicodeScalars)
    var at = 0
    var i = 0
    while i < s.count {
        guard let (m, mEnd) = match(s, i) else {
            i += 1
            continue
        }
        var end = mEnd
        push(Span(string(s[at..<i])))
        switch m {
        case .code(let t): push(Span(t, code: true))
        // The agent's words show only where a link chip would: on GitHub and a Claude artifact.
        case .link(let t, let href): push(Span(linkChip(url: href, title: t).label, href: href))
        case .bold(let inner): inline(inner, bold: true).forEach(push)
        case .url(let raw):
            // What ends a sentence rather than a URL: "see https://x.dev/a." links https://x.dev/a.
            var url = Array(raw.unicodeScalars)
            while let last = url.last, ".,;:!?'\")]".unicodeScalars.contains(last) { url.removeLast() }
            end = i + url.count
            let shown = url.dropFirst(scheme(url, 0) ?? 0)
            push(Span(string(shown), href: string(url[...])))
        }
        // A trimmed tail goes back to the text after it.
        at = end
        i = end
    }
    push(Span(string(s[at...])))
    return spans
}

/** After a line's marker: one or more spaces, then the rest, which `.*$` must match whole. */
private func rest(_ line: ArraySlice<Unicode.Scalar>, after i: Int) -> String? {
    var j = i
    while j < line.endIndex, isSpace(line[j]) { j += 1 }
    guard j > i, !line[j...].contains(where: isLineTerminator) else { return nil }
    return string(line[j...])
}

/** Fences open and close on a line starting with ```; an unclosed one runs to the end. */
public func parseContext(_ text: String) -> [Block] {
    var blocks: [Block] = []
    var code: [String]?
    func close() {
        if let c = code {
            let body = Array(c.joined(separator: "\n").unicodeScalars)
            var end = body.count
            while end > 0, isSpace(body[end - 1]) { end -= 1 }
            if end > 0 { blocks.append(.code(string(body[..<end]))) }
        }
        code = nil
    }
    // \r\n? to \n, then split on \n.
    var lines: [Scalars] = [[]]
    let all = Array(text.unicodeScalars)
    var k = 0
    while k < all.count {
        let u = all[k]
        if u == "\r" || u == "\n" {
            if u == "\r", k + 1 < all.count, all[k + 1] == "\n" { k += 1 }
            lines.append([])
        } else {
            lines[lines.count - 1].append(u)
        }
        k += 1
    }
    for raw in lines {
        var lead = 0
        while lead < raw.count, isSpace(raw[lead]) { lead += 1 }
        if hasPrefix(raw, lead, "```") {
            if code != nil { close() } else { code = [] }
            continue
        }
        if code != nil {
            code!.append(string(raw[...]))
            continue
        }
        let line = trimmed(raw)
        guard let first = line.first else { continue }
        let start = line.startIndex
        if first == "-" || first == "*" || first == "•", let r = rest(line, after: start + 1) {
            blocks.append(.item(marker: "•", spans: inline(r)))
            continue
        }
        var d = start
        while d < line.endIndex, ("0"..."9").contains(line[d]) { d += 1 }
        if (1...3).contains(d - start), d < line.endIndex, line[d] == "." || line[d] == ")", let r = rest(line, after: d + 1) {
            blocks.append(.item(marker: string(line[start..<d]) + ".", spans: inline(r)))
            continue
        }
        var h = start
        while h < line.endIndex, line[h] == "#" { h += 1 }
        // A heading is a bold line: a card has no room for sizes.
        if (1...6).contains(h - start), let r = rest(line, after: h) {
            blocks.append(.line(inline(r, bold: true)))
            continue
        }
        blocks.append(.line(inline(string(line))))
    }
    close()
    return blocks
}

/** The context as plain lines, for a notification, which shows no formatting. */
public func contextText(_ text: String) -> String {
    parseContext(text).map { b in
        switch b {
        case .code(let t): t
        case .item(let marker, let spans): "\(marker) \(spans.map(\.text).joined())"
        case .line(let spans): spans.map(\.text).joined()
        }
    }.joined(separator: "\n")
}

// What a link chip shows (spec/items.md, "Links"): the port of packages/protocol's links.ts, which
// vectors/links.json keeps in step. A link that matches no rule exactly keeps the plain chip: no
// icon, its title, else its host and path. Nothing here fetches the URL. Text is read by Unicode
// scalars, as JavaScript reads code points, never by Swift's grapheme clusters.

/** A chip's icon: GitHub's Octicons for GitHub's kinds (#971), a window for a Claude artifact. */
public enum LinkIcon: String, CaseIterable, Sendable {
    case pull, issue, discussion, run, release, commit, file, github, artifact
}

public struct LinkChip: Equatable, Sendable {
    public let icon: LinkIcon?
    public let label: String

    public init(icon: LinkIcon?, label: String) {
        self.icon = icon
        self.label = label
    }
}

/**
 * A link's chip (#971, #1577). A GitHub pull request, issue or discussion reads "#123", a release
 * its tag, a commit its short hash, each led by the repo when it isn't `project`, the session's;
 * the icon says what the number is, so the agent's title gives way. Another GitHub page and a
 * Claude artifact read as the agent's title, else a GitHub file its name, a run "Actions run",
 * another GitHub page its path, an artifact "Claude artifact". Any other host shows its host and
 * path, never the agent's title: only those two sites, whose icons name them, get a chip in the
 * agent's words, so no title dresses another site as one of them (#1722, #2203). A title with
 * hidden or reordering characters counts as none. A link that can't be read shows as written.
 */
public func linkChip(url: String, title: String?, project: String = "") -> LinkChip {
    guard let parts = parseURL(url) else { return LinkChip(icon: nil, label: clip(url)) }
    let gh = gitHubHosts.contains(parts.host) ? gitHub(parts.path) : nil
    if let gh, let ref = gh.ref {
        let same = asciiLower(gh.repo) == asciiLower(project)
        let sep = ref.hasPrefix("#") ? "" : " "
        return LinkChip(icon: gh.icon, label: clip(same ? ref : gh.repo + sep + ref))
    }
    let shown = title.flatMap { $0.isEmpty || isHidden($0) ? nil : $0 }
    if let gh { return LinkChip(icon: gh.icon, label: shown ?? clip(gh.text)) }
    let host = parts.host.hasPrefix("www.") ? String(parts.host.dropFirst(4)) : parts.host
    if parts.host == "claude.ai" && isArtifact(parts.path) {
        return LinkChip(icon: .artifact, label: shown ?? "Claude artifact")
    }
    return LinkChip(icon: nil, label: clip(host + (parts.path == "/" ? "" : parts.path)))
}

private func isHidden(_ text: String) -> Bool {
    text.unicodeScalars.contains { s in hidden.contains { $0.contains(s.value) } }
}

private let gitHubHosts: Set<String> = ["github.com", "www.github.com"]

/** claude.ai/artifact/<id>, /code/artifact/<id> and the shared /public/artifacts/<id>. */
private func isArtifact(_ path: String) -> Bool {
    var segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    // A path starts with "/"; one trailing "/" is allowed.
    guard segments.first == "" else { return false }
    segments.removeFirst()
    if segments.count > 1, segments.last == "" { segments.removeLast() }
    guard let id = segments.last, (1...64).contains(id.unicodeScalars.count),
          id.unicodeScalars.allSatisfy({ isAlnum($0) || $0 == "_" || $0 == "-" }) else { return false }
    let prefix = segments.dropLast()
    return prefix == ["artifact"] || prefix == ["code", "artifact"] || prefix == ["public", "artifacts"]
}

/**
 * The host (lowercase) and path of an https URL, read by hand as links.ts does rather than by
 * Foundation's URL, which disagrees at the edges. An authority with anything but letters, digits,
 * dots and hyphens (a user, a port, a backslash) gives nil: the URL shows as written.
 */
private func parseURL(_ url: String) -> (host: String, path: String)? {
    let scalars = Array(url.unicodeScalars)
    let scheme = Array("https://".unicodeScalars)
    guard scalars.starts(with: scheme), !scalars.contains("\\") else { return nil }
    let rest = scalars.dropFirst(scheme.count)
    let end = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
    let host = rest[rest.startIndex..<end]
    guard !host.isEmpty, host.allSatisfy({ isAlnum($0) || $0 == "." || $0 == "-" }) else { return nil }
    let tail = rest[end...]
    let pathEnd = tail.firstIndex { $0 == "?" || $0 == "#" } ?? tail.endIndex
    let path = string(tail[tail.startIndex..<pathEnd])
    // A "." or ".." segment, even percent-encoded, makes the browser open another page than the
    // path reads: show the URL as written.
    if path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { isDots(String($0)) }) { return nil }
    return (asciiLower(string(host)), path.isEmpty ? "/" : path)
}

/** ".", "..", or either with a dot written "%2e". */
private func isDots(_ segment: String) -> Bool {
    var rest = Substring(asciiLower(segment))
    var dots = 0
    while !rest.isEmpty {
        if rest.hasPrefix(".") { rest = rest.dropFirst() } else if rest.hasPrefix("%2e") { rest = rest.dropFirst(3) } else { return false }
        dots += 1
    }
    return (1...2).contains(dots)
}

private struct GitHub {
    let icon: LinkIcon
    let repo: String
    var ref: String?
    let text: String
}

/** What a github.com path points at; `text` is the label for a page with no ref. */
private func gitHub(_ path: String) -> GitHub {
    var trimmed = Substring(path)
    while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
    let segments = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    func at(_ i: Int) -> String { i < segments.count ? segments[i] : "" }
    let (owner, name, section, a, b) = (at(1), at(2), at(3), at(4), at(5))
    let repo = !owner.isEmpty && !name.isEmpty ? name : ""
    let text = trimmed.isEmpty ? "GitHub" : String(trimmed.dropFirst())
    let other = GitHub(icon: .github, repo: repo, ref: nil, text: text.isEmpty ? "GitHub" : text)
    if repo.isEmpty { return other }
    func number(_ icon: LinkIcon) -> GitHub {
        isDigits(a) ? GitHub(icon: icon, repo: repo, ref: "#" + a, text: other.text) : other
    }
    let file = segments.last ?? ""
    switch section {
    case "pull": return number(.pull)
    case "issues": return number(.issue)
    case "discussions": return number(.discussion)
    case "actions" where a == "runs" && isDigits(b): return GitHub(icon: .run, repo: repo, ref: nil, text: "Actions run")
    case "releases" where a == "tag" && !b.isEmpty: return GitHub(icon: .release, repo: repo, ref: decode(b), text: other.text)
    case "commit" where isSHA(a):
        return GitHub(icon: .commit, repo: repo, ref: asciiLower(String(String.UnicodeScalarView(a.unicodeScalars.prefix(7)))), text: other.text)
    // /blob/<ref>/<path>: a branch may hold slashes, but the last segment is always the file.
    case "blob" where !a.isEmpty && segments.count > 5 && !file.isEmpty:
        return GitHub(icon: .file, repo: repo, ref: nil, text: decode(file))
    default: return other
    }
}

private func isDigits(_ s: String) -> Bool {
    (1...20).contains(s.unicodeScalars.count) && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) }
}

private func isSHA(_ s: String) -> Bool {
    (7...40).contains(s.unicodeScalars.count) && s.unicodeScalars.allSatisfy { hex($0) >= 0 }
}

private func isAlnum(_ c: Unicode.Scalar) -> Bool {
    ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c)
}

private func hex(_ c: Unicode.Scalar) -> Int {
    switch c {
    case "0"..."9": Int(c.value - 0x30)
    case "a"..."f": Int(c.value - 0x61 + 10)
    case "A"..."F": Int(c.value - 0x41 + 10)
    default: -1
    }
}

/** ASCII letters lowercased, as JavaScript lowercases a host or a repo name made of them. */
private func asciiLower(_ s: String) -> String {
    string(s.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 })
}

private func string<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars)
    return String(view)
}

/**
 * Characters that would hide or reorder what a chip says: controls, bidi marks and the rest of
 * Unicode's default-ignorable code points (soft hyphen, zero-width, variation selectors, tags).
 */
private let hidden: [ClosedRange<UInt32>] = [
    0x0...0x1F, 0x7F...0x9F, 0xAD...0xAD, 0x34F...0x34F, 0x61C...0x61C, 0x115F...0x1160, 0x17B4...0x17B5, 0x180B...0x180F,
    0x200B...0x200F, 0x202A...0x202E, 0x2060...0x206F, 0x3164...0x3164, 0xFE00...0xFE0F, 0xFEFF...0xFEFF, 0xFFA0...0xFFA0,
    0xFFF0...0xFFFB, 0x1BCA0...0x1BCA3, 0x1D173...0x1D17A, 0xE0000...0xE0FFF,
]

/**
 * A percent-decoded segment, as JavaScript's decodeURIComponent reads it (a "+" stays a "+"),
 * else the segment as written when it is malformed or decodes to a character that would hide or
 * reorder the chip's text.
 */
private func decode(_ segment: String) -> String {
    let input = Array(segment.unicodeScalars)
    var bytes: [UInt8] = []
    var i = 0
    while i < input.count {
        if input[i] == "%" {
            guard i + 2 < input.count else { return segment }
            let hi = hex(input[i + 1]), lo = hex(input[i + 2])
            guard hi >= 0, lo >= 0 else { return segment }
            bytes.append(UInt8(hi << 4 | lo))
            i += 3
        } else {
            bytes.append(contentsOf: Array(String(input[i]).utf8))
            i += 1
        }
    }
    var out: [Unicode.Scalar] = []
    var iterator = bytes.makeIterator()
    var utf8 = UTF8()
    decoding: while true {
        switch utf8.decode(&iterator) {
        case let .scalarValue(s): out.append(s)
        case .emptyInput: break decoding
        case .error: return segment
        }
    }
    if out.contains(where: { s in hidden.contains { $0.contains(s.value) } }) { return segment }
    return string(out)
}

/** At most 40 code points, the 40th an ellipsis when cut. */
private func clip(_ text: String, _ max: Int = 40) -> String {
    let scalars = Array(text.unicodeScalars)
    return scalars.count > max ? string(scalars.prefix(max - 1)) + "…" : text
}

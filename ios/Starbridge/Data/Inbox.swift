import CoreGraphics
import Foundation
import StarbridgeProtocol

/** A body kept as its signed text, parsed once when read back. */
private func parsedBody<T: ItemBody>(_ kind: String, _ text: String) throws -> T {
    guard let b = try parseBody(kind, text).item as? T else { throw ProtocolError(.wrongKind, kind) }
    return b
}

/** A machine's question as this iPhone keeps it, with what became of it. */
struct SavedDecision: Codable, Equatable {
    let from: String
    let text: String
    var answeredAt: String?
    /** This iPhone's answer, once the server took it. */
    var answer: String?
    /** Another device's answer, as the asking machine's settled notice named it (#330). */
    var theirAnswer: String?
    var answeredBy: String?
    /** How a settled notice closed it, and the agent's reason for a withdrawal (#1008). */
    var settled: String?
    var reason: String?
    var waiting: String?
    var waitingAt: String?
    var snoozedUntil: String?
    var snoozedAt: String?
    /** Its images, opened from the item's blobs once, as it is kept (#685); a broken one is left out. */
    var images: [SavedImage] = []
    let body: Decision

    enum CodingKeys: String, CodingKey {
        case from, text, answeredAt, answer, theirAnswer, answeredBy, settled, reason, waiting, waitingAt, snoozedUntil, snoozedAt, images
    }

    init(from: String, text: String, answeredAt: String?) throws {
        self.from = from
        self.text = text
        self.answeredAt = answeredAt
        body = try parsedBody("decision", text)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(String.self, forKey: .from)
        text = try c.decode(String.self, forKey: .text)
        answeredAt = try c.decodeIfPresent(String.self, forKey: .answeredAt)
        answer = try c.decodeIfPresent(String.self, forKey: .answer)
        theirAnswer = try c.decodeIfPresent(String.self, forKey: .theirAnswer)
        answeredBy = try c.decodeIfPresent(String.self, forKey: .answeredBy)
        settled = try c.decodeIfPresent(String.self, forKey: .settled)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        waiting = try c.decodeIfPresent(String.self, forKey: .waiting)
        waitingAt = try c.decodeIfPresent(String.self, forKey: .waitingAt)
        snoozedUntil = try c.decodeIfPresent(String.self, forKey: .snoozedUntil)
        snoozedAt = try c.decodeIfPresent(String.self, forKey: .snoozedAt)
        images = try c.decodeIfPresent([SavedImage].self, forKey: .images) ?? []
        body = try parsedBody("decision", text)
    }

    var id: String { body.id }
    var isOpen: Bool { answeredAt == nil && answer == nil }
    /** Listed answered, without its images: the detail fetches them when it shows (#1382). */
    var imagesPending: Bool { images.isEmpty && !(body.images ?? []).isEmpty }

    /** Until when the owner put it off; none after Back now, whose time is its own (#571). */
    var snoozed: Date? {
        guard isOpen, let until = snoozedUntil.flatMap(Dates.parse) else { return nil }
        if let at = snoozedAt.flatMap(Dates.parse), until <= at { return nil } // order-ok: Back now, until against its own at
        return until > Date() ? until : nil
    }
}

/**
 * An image of a question, opened: the shape its body names, its bytes in a file of their own
 * beside the saved state, so the state the app rewrites and the notification extension reads
 * stays small.
 */
struct SavedImage: Codable, Equatable {
    let type: String
    let width: Int
    let height: Int
    let alt: String?
    /** The file's name in `SavedImage.directory`. */
    let file: String

    /** Where the images live: an `images` folder beside the saved state, set by the store. */
    nonisolated(unsafe) static var directory = FileManager.default.temporaryDirectory.appendingPathComponent("images")

    /** Writes `image`'s bytes as the `index`th image of question `decision`; nil when it cannot. */
    init?(_ image: ShownImage, decision: String, index: Int) {
        type = image.type
        width = image.width
        height = image.height
        alt = image.alt
        file = "\(decision).\(index)"
        do {
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
            Self.excludeFromBackup()
            try Data(image.data).write(to: Self.directory.appendingPathComponent(file), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return nil
        }
    }

    /** Keeps the folder out of backups, as the saved state is: its images are decrypted questions. */
    static func excludeFromBackup() {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = directory
        try? folder.setResourceValues(values)
    }

    var bytes: Data { (try? Data(contentsOf: Self.directory.appendingPathComponent(file))) ?? Data() }
    var aspect: CGFloat { height > 0 ? CGFloat(width) / CGFloat(height) : 1 }

    /** A question's images that open from `item`'s blobs, each written to its file. */
    static func keep(_ item: SealedItem, _ d: Decision) -> [SavedImage] {
        Images.open(item, images: d.images).enumerated().compactMap { SavedImage($1, decision: d.id, index: $0) }
    }

    /** Deletes the files of questions no longer kept. */
    static func prune(keeping decisions: [SavedDecision]) {
        let kept = Set(decisions.flatMap { $0.images.map(\.file) })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where !kept.contains(name) { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
    }
}

/** A machine's permission prompt as this iPhone keeps it. */
struct SavedPrompt: Codable, Equatable {
    let from: String
    let text: String
    var answeredAt: String?
    /** This iPhone's answer: `allow:<scope>` or `deny`. */
    var answer: String?
    let body: Permission

    enum CodingKeys: String, CodingKey { case from, text, answeredAt, answer }

    init(from: String, text: String, answeredAt: String?) throws {
        self.from = from
        self.text = text
        self.answeredAt = answeredAt
        body = try parsedBody("permission", text)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(String.self, forKey: .from)
        text = try c.decode(String.self, forKey: .text)
        answeredAt = try c.decodeIfPresent(String.self, forKey: .answeredAt)
        answer = try c.decodeIfPresent(String.self, forKey: .answer)
        body = try parsedBody("permission", text)
    }

    var id: String { body.id }

    /** What the agent says the call does, else the tool: the prompt's title everywhere (#805). */
    var headline: String { body.description.map(visible).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? body.tool }

    /**
     * The input as the owner reads it before allowing, as Android and the web show it (#276): a
     * command's full text, then its other fields but the description; any other input as it came.
     * The summary is capped at 200 characters, so a command's tail can hide past it.
     */
    var fullInput: String {
        let shown: String
        if case let .object(o)? = try? JSON.parse(body.input), let command = o["command"]?.string {
            var rest = JSONObject()
            for (k, v) in o where k != "command" && k != "description" { rest[k] = v }
            shown = rest.count == 0 ? command : "\(command)\n\n\(JSON.object(rest).text)"
        } else {
            shown = body.input
        }
        return visible(shown.isEmpty ? body.summary : shown)
    }

    /** The longest input a card's line holds, in UTF-16 units as the web and Android count it. */
    static let rowInputMax = 200

    /** Whether the whole input fits a card's line, so the card may carry Allow (#356). */
    var fitsRow: Bool { let s = fullInput; return s.utf16.count <= Self.rowInputMax && !s.contains("\n") }

    /** Still answerable here: unanswered, and inside its answer window. */
    var isOpen: Bool {
        answeredAt == nil && answer == nil && (Dates.parse(body.expiresAt).map { $0 > Date() } ?? false)
    }
}

/** One update of a `starbridge run`, the latest this iPhone has. */
/** A machine's latest quota snapshot, as this iPhone keeps it: its signer and the signed text. */
struct SavedQuota: Codable, Equatable {
    let from: String
    let text: String
    let body: QuotaSnapshot

    enum CodingKeys: String, CodingKey { case from, text }

    init(from: String, text: String) throws {
        self.from = from
        self.text = text
        body = try parsedBody("quota", text)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(from: try c.decode(String.self, forKey: .from), text: try c.decode(String.self, forKey: .text))
    }

    static func == (a: SavedQuota, b: SavedQuota) -> Bool { a.from == b.from && a.text == b.text }
}

struct SavedRun: Codable, Equatable {
    let from: String
    let text: String
    let body: Run

    enum CodingKeys: String, CodingKey { case from, text }

    init(from: String, text: String) throws {
        self.from = from
        self.text = text
        body = try parsedBody("run", text)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(String.self, forKey: .from)
        text = try c.decode(String.self, forKey: .text)
        body = try parsedBody("run", text)
    }

    var id: String { body.id }

    /** When its machine last said anything about it. */
    var lastNews: Date { Dates.parse(body.at) ?? .distantPast }

    /** When the last news came: the exit, else the last update. */
    var news: Date { body.exit.flatMap { Dates.parse($0.at) } ?? lastNews }

    var started: Date { Dates.instant(body.startedAt) }

    /** Neither ended nor lost. */
    var running: Bool { body.exit == nil && !lost }

    /** A finished or lost run stays on the screen this long, so its result is seen (#827). */
    static let shownAfter: TimeInterval = 30 * 60

    /** Running runs, newest first, then the others that ended or went lost in the last 30 minutes, latest news first. */
    static func shown(_ runs: [SavedRun], now: Date) -> [SavedRun] {
        let running = runs.filter(\.running).sorted { $0.started > $1.started }
        let ended = runs.filter { !$0.running && now.timeIntervalSince($0.news) <= shownAfter }.sorted { $0.news > $1.news }
        return running + ended
    }

    /** Ended with a non-zero exit code. */
    var failed: Bool { (body.exit?.code ?? 0) != 0 }

        /** Running with no update for RUN_STALE_MS: its machine is gone. */
    var lost: Bool { body.exit == nil && Date().timeIntervalSince(lastNews) * 1000 > Double(RUN_STALE_MS) }
}

/**
 * An answer signed and sealed, kept until the server takes it (#329): tapped offline, it goes
 * once the server can be reached. `mayHaveLanded` once a try may have reached the server, so a
 * later `already-answered` is taken as this answer's.
 */
struct QueuedAnswer: Codable, Equatable {
    let decisionId: String
    /** What the owner chose or typed, as the card shows it. */
    let answer: String
    /** The sealed item's JSON text. */
    let item: String
    let at: String
    var mayHaveLanded = false
}

/** An element of a saved list: one that no longer reads is dropped, not the whole file. */
struct Lossy<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/** The directory head a machine signed into its items (#362), as JSON text. */
struct SavedHead: Codable, Equatable {
    let id: String
    let head: String
}

extension Heads {
    /** The heads `saved` keeps, each under its key; one this app cannot read is left out. */
    init(saved: [SavedHead]) {
        self.init()
        for h in saved {
            if let json = try? JSON.parse(h.head), let head = try? DirectoryHead(json: json) { self[h.id] = head }
        }
    }
}

/**
 * Which of two updates of one decision every client keeps, whatever order they arrive in: a push
 * and a poll bring them in different orders on different devices. The web, the CLI and Android
 * apply the same rule; packages/protocol/vectors/rules.json, "order", holds its cases (#2103).
 */
enum Order {
    /** The later instant wins, and on equal instants the earlier `until`, so a question shows rather than hides. */
    static func laterSnooze(keptAt: String?, keptUntil: String?, at: String, until: String) -> Bool {
        guard let next = Dates.parse(at) else { return false }
        guard let kept = keptAt.flatMap(Dates.parse) else { return true }
        if kept != next { return next > kept }
        guard let a = keptUntil.flatMap(Dates.parse), let b = Dates.parse(until) else { return false }
        return b < a
    }

    /** The later instant wins, and on equal instants `waiting`, which tells the owner the agent is blocked. */
    static func laterWaiting(keptAt: String?, keptState: String?, at: String, state: String) -> Bool {
        guard let next = Dates.parse(at) else { return false }
        guard let kept = keptAt.flatMap(Dates.parse) else { return true }
        if kept != next { return next > kept }
        return state == "waiting" && keptState != "waiting"
    }
}

/**
 * What this iPhone remembers of the pushes about one question (#2151): closed by an `answered`
 * or settled push (unverified, so it only keeps notifications down), rang once, the last
 * waiting flip applied, and the `at` of the snooze whose return rang.
 */
struct Notified: Codable, Equatable, Sendable {
    var closed = false
    var rang = false
    var waitingAt: String?
    var waiting: String?
    var back: String?
}

/** A push about a question, as the iPhone opened it. */
enum NotifyEvent: Equatable, Sendable {
    case asked
    case closed
    case flip(at: String, state: String)
    case back(at: String, due: Bool)
}

/** What a push does: shows the question with a sound, updates it without one, or nothing. */
enum NotifyEffect: String, Sendable {
    case ring, quiet, none
}

extension Order {
    /**
     * What a push about one question does to its notification, whatever order pushes arrive in
     * and however often: packages/protocol/src/notify.ts's `notifyStep`, which the web and
     * Android apply too; rules.json, "notify", holds its cases (#2151).
     */
    static func notifyStep(_ kept: Notified, _ event: NotifyEvent) -> (Notified, NotifyEffect) {
        var next = kept
        if event == .closed {
            next.closed = true
            return (next, .none)
        }
        if kept.closed { return (kept, .none) }
        switch event {
        case .asked:
            if kept.rang { return (kept, .none) }
            next.rang = true
            return (next, .ring)
        case let .flip(at, state):
            // The same flip again, or one older than the last applied, changes nothing.
            guard laterWaiting(keptAt: kept.waitingAt, keptState: kept.waiting, at: at, state: state) else { return (kept, .none) }
            next.waitingAt = at
            next.waiting = state
            next.rang = true
            // Its first push is a flip: the owner has not heard of the question yet.
            if !kept.rang { return (next, .ring) }
            return (next, state == "waiting" && kept.waiting != "waiting" ? .ring : .quiet)
        case let .back(at, due):
            // Its return rings once, and an older snooze's return, after a newer one's, not at all.
            if !due { return (kept, .none) }
            if let back = kept.back, !(Dates.parse(at).map { a in Dates.parse(back).map { a > $0 } ?? false } ?? false) { return (kept, .none) }
            next.back = at
            next.rang = true
            return (next, .ring)
        case .closed:
            return (next, .none)
        }
    }
}

enum Dates {
    static func parse(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text)
    }

    /** A stamp as an instant; one that doesn't parse sorts first. */
    static func instant(_ text: String) -> Date { parse(text) ?? .distantPast }

    /** Oldest first, comparing stamps as instants (#1079), each parsed once. */
    static func byInstant<T>(_ items: [T], _ stamp: (T) -> String) -> [T] {
        items.map { (instant(stamp($0)), $0) }.sorted { $0.0 < $1.0 }.map(\.1)
    }

    static func format(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }
}

extension Decision {
    /**
     * The options, the agent's default first (spec/items.md, #191). Compared by code points, as
     * the schema does: Swift's == would equate "é" and "e\u{301}", two options.
     */
    var ordered: [String] {
        guard let r = recommended else { return options }
        return [r] + options.filter { !sameOption($0, r) }
    }
}

/** The same option, by code points, as the schema compares them. */
func sameOption(_ a: String, _ b: String?) -> Bool { b.map { Array(a.unicodeScalars) == Array($0.unicodeScalars) } ?? false }

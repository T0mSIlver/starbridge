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

    /** Until when the owner put it off; none after Back now, whose time is its own (#571). */
    var snoozed: Date? {
        guard isOpen, let until = snoozedUntil.flatMap(Dates.parse) else { return nil }
        if let at = snoozedAt.flatMap(Dates.parse), until <= at { return nil }
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
            try Data(image.data).write(to: Self.directory.appendingPathComponent(file), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return nil
        }
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

    /** Whether the whole input fits a card's line, so the card may carry Allow (#356). */
    var fitsRow: Bool { let s = fullInput; return s.count <= 200 && !s.contains("\n") }

    /** Still answerable here: unanswered, and inside its answer window. */
    var isOpen: Bool {
        answeredAt == nil && answer == nil && (Dates.parse(body.expiresAt).map { $0 > Date() } ?? false)
    }
}

/** One update of a `starbridge run`, the latest this iPhone has. */
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

enum Dates {
    static func parse(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text)
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

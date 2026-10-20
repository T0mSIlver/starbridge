import Foundation
import StarbridgeProtocol

/** This iPhone as a directory member. */
struct SavedMember: Codable, Equatable {
    let id: String
    let name: String
    let boxPk: String
    let signPk: String

    var member: Member { Member(id: id, role: .device, name: name, boxPk: boxPk, signPk: signPk) }
}

/** A join by digits in progress (PROTOCOL.md, "Joining by digits"). */
struct DigitJoin: Codable, Equatable {
    let id: String
    let request: String
    var approverKey: String?
    var digits: String?
    /** The owner saw the same digits on both screens. */
    var matched = false
}

/** What the app keeps between launches that is not secret. */
struct Saved: Codable, Equatable {
    /** The file's format (#473): this release reads only its own, and a file without `v` is format 1. */
    static let format = 1

    var v = Saved.format
    var server: String
    var account: String?
    /** The account to check a directory against: none verifies no directory (#1723). */
    var accountId: String { account ?? "" }
    /** The account already has a device, which this iPhone joins through. */
    var accountExists = false
    var me: SavedMember?
    var pinLength: Int?
    var pinHead: String?
    /** The directory as verified, each entry's JSON text. */
    var entries: [String] = []
    /** The pairing code of a join by a scanned QR code. */
    var joining: String?
    var digitJoin: DigitJoin?
    /**
     * The account's first entry, signed and kept until the owner confirms the recovery key, when
     * it goes to the server (#370). A lost reply is retried with the same entry.
     */
    var pendingGenesis: String?
    /** While recovering: the member whose keys this iPhone made, until the chain holds it. */
    var recovering: SavedMember?
    /** Where the decision and prompt lists left off. */
    var cursor = ""
    var promptCursor = ""
    var decisions: [SavedDecision] = []
    var prompts: [SavedPrompt] = []
    var runs: [SavedRun] = []
    /** The latest quota snapshot from each machine. */
    var quotas: [SavedQuota] = []
    /** Runs dismissed here, with the update they hid, until a newer one comes. */
    var dismissedRuns: [String: String] = [:]
    var outbox: [QueuedAnswer] = []
    var heads: [SavedHead] = []
    /** This iPhone's APNs subscription, dropped at sign-out. */
    var pushId: String?
    /** The last recovery key replacement the owner dismissed here (#348). */
    var recoverySeen = 0
    /**
     * Machines this iPhone approved from their QR, whose check key proves the entry to the
     * machine, which then asks nothing: Devices shows them no check code (#1329).
     */
    var scannedMachines: [String] = []

    init(server: String) { self.server = server }

    /** A field a newer release added reads as its default, so an update keeps the saved state. */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
        guard v == Saved.format else {
            throw DecodingError.dataCorruptedError(forKey: .v, in: c, debugDescription: "format \(v), this release reads \(Saved.format)")
        }
        server = try c.decode(String.self, forKey: .server)
        account = try c.decodeIfPresent(String.self, forKey: .account)
        accountExists = try c.decodeIfPresent(Bool.self, forKey: .accountExists) ?? false
        me = try c.decodeIfPresent(SavedMember.self, forKey: .me)
        pinLength = try c.decodeIfPresent(Int.self, forKey: .pinLength)
        pinHead = try c.decodeIfPresent(String.self, forKey: .pinHead)
        entries = try c.decodeIfPresent([String].self, forKey: .entries) ?? []
        joining = try c.decodeIfPresent(String.self, forKey: .joining)
        digitJoin = try c.decodeIfPresent(DigitJoin.self, forKey: .digitJoin)
        pendingGenesis = try c.decodeIfPresent(String.self, forKey: .pendingGenesis)
        recovering = try c.decodeIfPresent(SavedMember.self, forKey: .recovering)
        cursor = try c.decodeIfPresent(String.self, forKey: .cursor) ?? ""
        promptCursor = try c.decodeIfPresent(String.self, forKey: .promptCursor) ?? ""
        decisions = (try c.decodeIfPresent([Lossy<SavedDecision>].self, forKey: .decisions) ?? []).compactMap(\.value)
        prompts = (try c.decodeIfPresent([Lossy<SavedPrompt>].self, forKey: .prompts) ?? []).compactMap(\.value)
        runs = (try c.decodeIfPresent([Lossy<SavedRun>].self, forKey: .runs) ?? []).compactMap(\.value)
        quotas = (try c.decodeIfPresent([Lossy<SavedQuota>].self, forKey: .quotas) ?? []).compactMap(\.value)
        dismissedRuns = try c.decodeIfPresent([String: String].self, forKey: .dismissedRuns) ?? [:]
        outbox = (try c.decodeIfPresent([Lossy<QueuedAnswer>].self, forKey: .outbox) ?? []).compactMap(\.value)
        heads = try c.decodeIfPresent([SavedHead].self, forKey: .heads) ?? []
        pushId = try c.decodeIfPresent(String.self, forKey: .pushId)
        recoverySeen = try c.decodeIfPresent(Int.self, forKey: .recoverySeen) ?? 0
        scannedMachines = try c.decodeIfPresent([String].self, forKey: .scannedMachines) ?? []
    }

    var pin: Pin? {
        get { pinLength.flatMap { length in pinHead.map { Pin(length: length, head: $0) } } }
        set {
            pinLength = newValue?.length
            pinHead = newValue?.head
        }
    }
}

/** The app group the app shares with its notification service extension. */
let APP_GROUP = "group.dev.starbridge.ios"

/**
 * [Saved] as a JSON file, out of iCloud backups: in the app group's container, which the
 * notification service extension reads, else in Application Support.
 */
struct Disk {
    let url: URL

    static let standard: Disk = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("saved.json")
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: APP_GROUP)?.appendingPathComponent("saved.json") else {
            return Disk(url: support)
        }
        // Builds before the app group kept the file in Application Support: it moves once.
        if !FileManager.default.fileExists(atPath: group.path), FileManager.default.fileExists(atPath: support.path) {
            try? FileManager.default.moveItem(at: support, to: group)
        }
        return Disk(url: group)
    }()

    /** The saved state, nil when there is none; throws when the file is there but unreadable. */
    func read() throws -> Saved? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Saved.self, from: Data(contentsOf: url))
    }

    /** The saved state, or nil when there is none or it cannot be read; moves nothing. */
    func load() -> Saved? { try? read() }

    /** What the app found at launch. */
    enum Loaded {
        case saved(Saved?)
        /** Not this release's format, or damaged: kept as `saved.json.unreadable-<tag>`. */
        case aside(tag: String)
        /** Not read, or not moved aside: left where it is, and why. */
        case stuck(String)
    }

    /**
     * The saved state for the app. A file this release cannot decode, a newer release's or a
     * damaged one, moves aside to `saved.json.unreadable-<tag>`, kept rather than overwritten
     * (#473). A file it cannot read at all, such as before the first unlock, stays where it is.
     */
    func loadOrMoveAside() -> Loaded {
        guard FileManager.default.fileExists(atPath: url.path) else { return .saved(nil) }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return .stuck("\(error.localizedDescription)")
        }
        do {
            return .saved(try JSONDecoder().decode(Saved.self, from: data))
        } catch {
            let tag = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8).lowercased())"
            do {
                try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("unreadable-\(tag)"))
                return .aside(tag: tag)
            } catch {
                return .stuck("\(error.localizedDescription)")
            }
        }
    }

    /** Deletes the saved state and every copy set aside as `saved.json.unreadable-<tag>`. */
    func wipe() throws {
        let dir = url.deletingLastPathComponent()
        let name = url.lastPathComponent
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for n in names where n == name || n.hasPrefix(name + ".unreadable-") {
            try FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }

    func save(_ saved: Saved) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try target.setResourceValues(values)
    }
}

/**
 * What pushes did to each question (#2151), as JSON beside `saved.json` in the app group: the
 * notification extension writes what it rang, the app what `answered` and settled pushes closed.
 * Both go through a file coordinator, since the two processes write it.
 */
struct NotifiedFile {
    let url: URL

    static let standard = NotifiedFile(url: Disk.standard.url.deletingLastPathComponent().appendingPathComponent("notified.json"))

    /** How many questions it keeps, the oldest dropped first. */
    static let max = 300

    struct Book: Codable, Equatable {
        /** Question ids, oldest first. */
        var order: [String] = []
        var notified: [String: Notified] = [:]
    }

    func load() -> Book {
        (try? JSONDecoder().decode(Book.self, from: Data(contentsOf: url))) ?? Book()
    }

    /**
     * Runs `event` about question `id` through the rule and keeps what it leaves; the effect.
     * `known` is the question as the app saved it, when it did: a question the inbox listed is
     * not news, and a flip a sync read counts as the last one applied. `member` is this
     * iPhone's id in the account the push came for: once `saved.json` beside the file no longer
     * says so, as after a sign-out the push raced, nothing is kept and the effect is `none`.
     */
    @discardableResult
    func step(_ id: String, _ event: NotifyEvent, known: SavedDecision? = nil, member: String?) -> (Notified, NotifyEffect) {
        var out = (Notified(), NotifyEffect.none)
        var failed: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forMerging, error: &failed) { url in
            // Sign-out deletes this file through a coordinator too, after it wrote `saved.json`.
            guard let member, Disk(url: url.deletingLastPathComponent().appendingPathComponent("saved.json")).load()?.me?.id == member else { return }
            let file = NotifiedFile(url: url)
            var book = file.load()
            var remembered = book.notified[id] ?? Notified()
            if let known {
                remembered.rang = true
                if let at = known.waitingAt, let state = known.waiting,
                   Order.laterWaiting(keptAt: remembered.waitingAt, keptState: remembered.waiting, at: at, state: state) {
                    remembered.waitingAt = at
                    remembered.waiting = state
                }
            }
            out = Order.notifyStep(remembered, event)
            book.notified[id] = out.0
            book.order = book.order.filter { $0 != id } + [id]
            for gone in book.order.dropLast(Self.max) { book.notified[gone] = nil }
            book.order = Array(book.order.suffix(Self.max))
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONEncoder().encode(book).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var target = url
            try? target.setResourceValues(values)
        }
        return out
    }

    func delete() {
        var failed: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &failed) { url in
            try? FileManager.default.removeItem(at: url)
        }
    }
}

extension Saved {
    /** Questions still to answer: not answered, not snoozed, not sent from this iPhone (`sending`), from a member still `active`. */
    func openDecisions(sending: Set<String>, active: (String) -> Bool) -> [SavedDecision] {
        decisions.filter { $0.isOpen && $0.snoozed == nil && !sending.contains($0.id) && active($0.from) }
    }

    func openPrompts(active: (String) -> Bool) -> [SavedPrompt] {
        prompts.filter { $0.isOpen && active($0.from) }
    }
}

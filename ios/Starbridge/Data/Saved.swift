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
    /** Runs dismissed here, with the update they hid, until a newer one comes. */
    var dismissedRuns: [String: String] = [:]
    var outbox: [QueuedAnswer] = []
    var heads: [SavedHead] = []
    /** This iPhone's APNs subscription, dropped at sign-out. */
    var pushId: String?

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
        dismissedRuns = try c.decodeIfPresent([String: String].self, forKey: .dismissedRuns) ?? [:]
        outbox = (try c.decodeIfPresent([Lossy<QueuedAnswer>].self, forKey: .outbox) ?? []).compactMap(\.value)
        heads = try c.decodeIfPresent([SavedHead].self, forKey: .heads) ?? []
        pushId = try c.decodeIfPresent(String.self, forKey: .pushId)
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

    func save(_ saved: Saved) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try target.setResourceValues(values)
    }
}

// The Swift side of packages/protocol/src/schemas.ts. Each type reads a JSON value with the
// checks zod makes there (Validate.swift) and writes itself back in the schema's key order.

public let RECOVERY = "recovery"

// --- Directory ---------------------------------------------------------------

public enum Role: String, Sendable { case device, machine }

/** A device (phone, browser) or a machine (where agents run) and its public keys. */
public struct Member: Equatable, Sendable {
    public let id: String
    public let role: Role
    public let name: String
    /** X25519, for sealed boxes. */
    public let boxPk: String
    /** Ed25519, for signatures. */
    public let signPk: String

    public init(id: String, role: Role, name: String, boxPk: String, signPk: String) {
        self.id = id
        self.role = role
        self.name = name
        self.boxPk = boxPk
        self.signPk = signPk
    }

    init(_ f: Fields) throws {
        id = try f.id("id")
        role = Role(rawValue: try f.oneOf("role", ["device", "machine"]))!
        name = try f.text("name", 1, 100)
        boxPk = try f.bytes32("boxPk")
        signPk = try f.bytes32("signPk")
    }

    public init(json: JSON) throws { try self.init(Fields(json, "member")) }

    public var json: JSON {
        ["id": .string(id), "role": .string(role.rawValue), "name": .string(name), "boxPk": .string(boxPk), "signPk": .string(signPk)]
    }
}

/**
 * A directory entry: `member` (and `recoveryPk` on entry 0) on add and recover, `id` on revoke,
 * `recoveryPk` on a recovery proposal, `proposal` and `recoveryPk` on its confirmation.
 */
public struct DirectoryEntry: Equatable, Sendable {
    public enum Op: Equatable, Sendable {
        case add(Member, recoveryPk: String?)
        case revoke(id: String)
        case recover(Member)
        case recovery(recoveryPk: String)
        case recoveryConfirm(proposal: Int, recoveryPk: String)

        var name: String {
            switch self {
            case .add: "add"
            case .revoke: "revoke"
            case .recover: "recover"
            case .recovery: "recovery"
            case .recoveryConfirm: "recovery-confirm"
            }
        }
    }

    public let account: String
    public let seq: Int
    /** Hash of the previous entry's body; nil only on the first entry. */
    public let prev: String?
    public let at: String
    public let op: Op

    public init(account: String, seq: Int, prev: String?, at: String, op: Op) {
        self.account = account
        self.seq = seq
        self.prev = prev
        self.at = at
        self.op = op
    }

    public init(json: JSON) throws {
        let f = try Fields(json, "")
        try f.version()
        account = try f.id("account")
        seq = try f.int("seq")
        try schema(seq >= 0, "seq")
        prev = try f.nullable("prev").map { try asString($0, "prev") }
        if let prev { try checkBytes(prev, 43, "prev") }
        at = try f.time("at")
        // An op this client does not know is refused: skipping a recovery confirmation would keep
        // a replaced key trusted (PROTOCOL.md, "Directory").
        switch try f.string("op") {
        case "add":
            let member = try Member(f.child("member"))
            let pk = try f.optString("recoveryPk")
            if let pk { try checkBytes(pk, 43, "recoveryPk") }
            op = .add(member, recoveryPk: pk)
        case "revoke": op = .revoke(id: try f.id("id"))
        case "recover": op = .recover(try Member(f.child("member")))
        case "recovery": op = .recovery(recoveryPk: try f.bytes32("recoveryPk"))
        case "recovery-confirm":
            let proposal = try f.int("proposal")
            try schema(proposal >= 0, "proposal")
            op = .recoveryConfirm(proposal: proposal, recoveryPk: try f.bytes32("recoveryPk"))
        default: throw ProtocolError(.badSchema, "op")
        }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "account": .string(account), "seq": JSON(seq), "prev": prev.map(JSON.string) ?? .null, "at": .string(at), "op": .string(op.name)]
        switch op {
        case .add(let m, let pk):
            o["member"] = m.json
            o.put("recoveryPk", pk.map(JSON.string))
        case .revoke(let id): o["id"] = .string(id)
        case .recover(let m): o["member"] = m.json
        case .recovery(let pk): o["recoveryPk"] = .string(pk)
        case .recoveryConfirm(let proposal, let pk):
            o["proposal"] = JSON(proposal)
            o["recoveryPk"] = .string(pk)
        }
        return .object(o)
    }
}

extension JSONObject: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSON)...) { self.init(elements) }
}

// --- Signed and sealed envelopes ---------------------------------------------

/** Each sealed kind's rules (ITEM_KINDS in schemas.ts): who signs it, and its hint fields. */
public enum ItemKind: String, CaseIterable, Sendable {
    case decision, answer, quota, permission
    case permissionAnswer = "permission-answer"
    case settled, run, waiting, snooze

    /** The role that signs it; it is sealed to members of the other role. */
    public var signer: Role {
        switch self {
        case .decision, .quota, .permission, .settled, .run, .waiting: .machine
        case .answer, .permissionAnswer, .snooze: .device
        }
    }
}

/** The kinds a signature can be for: directory entries and every sealed kind. */
let KINDS: Set<String> = Set(["directory"] + ItemKind.allCases.map(\.rawValue))

/** `body` is the JSON text exactly as signed. Verifiers check the signature over these bytes and only then parse them. */
public struct SignedEnvelope: Equatable, Sendable {
    public let kind: String
    public let signer: String
    public let body: String
    public let sig: String
    /** Directory entry 0 and `recovery` entries only: the named recovery key's signature. */
    public let recoverySig: String?

    public init(kind: String, signer: String, body: String, sig: String, recoverySig: String? = nil) {
        self.kind = kind
        self.signer = signer
        self.body = body
        self.sig = sig
        self.recoverySig = recoverySig
    }

    public init(json: JSON) throws {
        let f = try Fields(json, "envelope")
        try f.version()
        kind = try f.oneOf("kind", KINDS)
        signer = try f.id("signer")
        body = try f.string("body")
        sig = try f.bytes64("sig")
        recoverySig = try f.optString("recoverySig")
        if let recoverySig { try checkBytes(recoverySig, 86, "recoverySig") }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "kind": .string(kind), "signer": .string(signer), "body": .string(body), "sig": .string(sig)]
        o.put("recoverySig", recoverySig.map(JSON.string))
        return .object(o)
    }
}

/** An image's blob, as base64url, at most: 384 KB of image, its nonce and MAC. */
public let BLOB_MAX = 512 * 1024 + 64

/** The key and hash that open and check an image's blob. */
public struct ImageRef: Equatable, Sendable {
    /** The blob's secretbox key, 32 bytes. */
    public let key: String
    /** BLAKE2b-256 of "starbridge/v1/image" NUL and the blob's bytes. */
    public let hash: String

    public init(key: String, hash: String) {
        self.key = key
        self.hash = hash
    }
}

public struct SealedBox: Equatable, Sendable {
    public let to: String
    public let box: String
}

/** What the server stores and relays; `kind`, `id`, `from`, `re` and `to` are routing hints. */
public struct SealedItem: Equatable, Sendable {
    public let kind: ItemKind
    public let id: String
    public let from: String
    /** The item this one refers to (ITEM_KINDS' `re`). */
    public let re: String?
    /** Store without pushing: a quota snapshot that raises no new alert. */
    public let quiet: Bool?
    /** A machine re-posts its open decision or permission under its id, to more devices. */
    public let reseal: Bool?
    /** A `wake` kind's time: the server pushes every device once then. */
    public let wakeAt: String?
    /** A decision's images, each sealed once for every device, in its body's order. */
    public let blobs: [String]?
    public let boxes: [SealedBox]

    init(kind: ItemKind, id: String, from: String, re: String?, wakeAt: String?, blobs: [String]?, boxes: [SealedBox]) {
        self.kind = kind
        self.id = id
        self.from = from
        self.re = re
        quiet = nil
        reseal = nil
        self.wakeAt = wakeAt
        self.blobs = blobs
        self.boxes = boxes
    }

    public init(json: JSON) throws {
        let f = try Fields(json, "item")
        try f.version()
        kind = ItemKind(rawValue: try f.oneOf("kind", Set(ItemKind.allCases.map(\.rawValue))))!
        id = try f.id("id")
        from = try f.id("from")
        re = try f.optId("re")
        quiet = try f.optTrue("quiet")
        reseal = try f.optTrue("reseal")
        wakeAt = try f.optTime("wakeAt")
        blobs = try f.optArray("blobs").map { items in
            try schema(items.count <= 4, "blobs")
            return try items.map {
                let s = try asString($0, "blobs")
                try checkB64(s, "blobs")
                try checkLength(s, 0, BLOB_MAX, "blobs")
                return s
            }
        }
        let boxes = try f.array("boxes")
        try schema((1...64).contains(boxes.count), "boxes")
        self.boxes = try boxes.map {
            let b = try Fields($0, "boxes")
            return SealedBox(to: try b.id("to"), box: try b.b64("box"))
        }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "kind": .string(kind.rawValue), "id": .string(id), "from": .string(from)]
        o.put("re", re.map(JSON.string))
        o.put("quiet", quiet.map(JSON.bool))
        o.put("reseal", reseal.map(JSON.bool))
        o.put("wakeAt", wakeAt.map(JSON.string))
        o.put("blobs", blobs.map { JSON($0) })
        o["boxes"] = .array(boxes.map { ["to": .string($0.to), "box": .string($0.box)] })
        return .object(o)
    }
}

// --- Decisions and answers ---------------------------------------------------

/** Where the owner can open the session that asked. */
public enum SessionLinkKind: String, Sendable {
    case remoteControl = "remote-control"
    case desktop, web

    /** The only URLs each kind may carry, so a client never opens a script or another site. */
    public var prefix: String {
        switch self {
        case .remoteControl, .web: "https://claude.ai/code/"
        case .desktop: "claude://claude.ai/"
        }
    }
}

private func isPrintableASCII(_ s: String) -> Bool {
    !s.utf8.isEmpty && s.utf8.allSatisfy { (0x21...0x7E).contains($0) }
}

public struct SessionLink: Equatable, Sendable {
    public let kind: SessionLinkKind
    public let url: String

    init(_ f: Fields) throws {
        kind = SessionLinkKind(rawValue: try f.oneOf("kind", ["remote-control", "desktop", "web"]))!
        url = try f.string("url")
        try schema(codePoints(url) <= 2048 && isPrintableASCII(url), "links.url")
        try schema(url.hasPrefix(kind.prefix), "url does not match its kind")
    }

    var json: JSON { ["kind": .string(kind.rawValue), "url": .string(url)] }
}

/** The coding agents clients know by name; items may carry another (`AgentName`). */
public let AGENTS: Set<String> = ["claude-code", "codex", "pi", "opencode", "cursor", "antigravity"]

/** `AgentName`: one of `AGENTS`, or a name a newer machine sends, which a client shows as none. */
func checkAgentName(_ s: String, _ what: String) throws {
    let c = Array(s.utf8)
    let ok = (1...40).contains(c.count) && c.enumerated().allSatisfy { i, ch in
        (0x61...0x7A).contains(ch) || (0x30...0x39).contains(ch) || (i > 0 && ch == 0x2D)
    }
    try schema(ok, what)
}

/** What a machine is, for its icon. */
public enum MachineKind: String, CaseIterable, Sendable { case server, desktop, laptop, cloud }

/** The machine, project and session an item comes from. */
public struct Source: Equatable, Sendable {
    public let machine: String
    public let machineKind: MachineKind?
    public let project: String
    public let session: String
    public let sessionTitle: String?
    public let links: [SessionLink]?

    init(_ f: Fields) throws {
        machine = try f.text("machine", 1, 100)
        machineKind = try f.optString("machineKind").map { k in
            guard let kind = MachineKind(rawValue: k) else { throw ProtocolError(.badSchema, "source.machineKind") }
            return kind
        }
        project = try f.text("project", 0, 200)
        session = try f.text("session", 0, 200)
        sessionTitle = try f.optText("sessionTitle", 0, 200)
        links = try f.optArray("links").map { items in
            try schema(items.count <= 3, "source.links")
            return try items.map { try SessionLink(Fields($0, "source.links")) }
        }
    }

    var json: JSON {
        var o: JSONObject = ["machine": .string(machine)]
        o.put("machineKind", machineKind.map { .string($0.rawValue) })
        o["project"] = .string(project)
        o["session"] = .string(session)
        o.put("sessionTitle", sessionTitle.map(JSON.string))
        o.put("links", links.map { .array($0.map(\.json)) })
        return .object(o)
    }
}

/** A picture attached to a decision; its bytes travel as the item's blob at the same index. */
public struct DecisionImage: Equatable, Sendable {
    public let ref: ImageRef
    /** image/png or image/jpeg: never SVG, which can carry script. */
    public let type: String
    public let width: Int
    public let height: Int
    public let alt: String?

    init(_ f: Fields) throws {
        let key = try f.bytes32("key")
        let hash = try f.bytes32("hash")
        ref = ImageRef(key: key, hash: hash)
        type = try f.oneOf("type", ["image/png", "image/jpeg"])
        width = try f.int("width")
        height = try f.int("height")
        try schema((1...8192).contains(width) && (1...8192).contains(height), "images.size")
        alt = try f.optText("alt", 0, 300)
    }

    var json: JSON {
        var o: JSONObject = ["key": .string(ref.key), "hash": .string(ref.hash), "type": .string(type), "width": JSON(width), "height": JSON(height)]
        o.put("alt", alt.map(JSON.string))
        return .object(o)
    }
}

/** A page the owner may open to decide; HTTPS only. */
public struct DecisionLink: Equatable, Sendable {
    public let url: String
    public let title: String?

    init(_ f: Fields) throws {
        url = try f.string("url")
        try schema(codePoints(url) <= 2048 && url.hasPrefix("https://") && isPrintableASCII(url) && url.utf8.count > 8, "links.url")
        title = try f.optText("title", 1, 100)
    }

    var json: JSON {
        var o: JSONObject = ["url": .string(url)]
        o.put("title", title.map(JSON.string))
        return .object(o)
    }
}

/**
 * A directory its signer vouches for: its length and the hash of its last entry. Machines sign
 * theirs into every item, devices into answers; each side refuses the other's items while an
 * active signer has signed a head its own chain lacks.
 */
public struct DirectoryHead: Equatable, Sendable {
    public let length: Int
    public let head: String
    /** A machine passing on a device's longer head names that device. */
    public let by: String?

    public init(length: Int, head: String, by: String? = nil) {
        self.length = length
        self.head = head
        self.by = by
    }

    public init(json: JSON) throws { try self.init(Fields(json, "dir")) }

    init(_ f: Fields) throws {
        length = try f.int("length")
        try schema((1...100_000).contains(length), "dir.length")
        head = try f.bytes32("head")
        by = try f.optId("by")
    }

    public var json: JSON {
        var o: JSONObject = ["length": JSON(length), "head": .string(head)]
        o.put("by", by.map(JSON.string))
        return .object(o)
    }

    var pin: Pin { Pin(length: length, head: head) }
}

/** A sealed item's body: its id, the item its `re` names, and the members it is sealed to. */
public protocol ItemBody: Sendable {
    var id: String { get }
    /** The item this one refers to, which the item's `re` hint repeats. */
    var re: String? { get }
    var recipients: [String] { get }
    /** The directory head its signer vouched for. */
    var dir: DirectoryHead? { get }
    /** A `wake` kind's time, which the item's `wakeAt` hint repeats. */
    var wakeAt: String? { get }
    var json: JSON { get }
}

extension ItemBody {
    public var re: String? { nil }
    public var wakeAt: String? { nil }
}

private func optDir(_ f: Fields) throws -> DirectoryHead? {
    try f.optional("dir").map { try DirectoryHead(Fields($0, "dir")) }
}

public struct Decision: ItemBody, Equatable {
    public let id: String
    /** Device ids this decision was sealed to. */
    public let to: [String]
    public let createdAt: String
    public let question: String
    public let context: String
    /** 2 to 4 choices, or none for a free-text answer. */
    public let options: [String]
    public let recommended: String?
    /** An agent name, when the machine can tell which agent asked. */
    public let agent: String?
    public let source: Source
    public let images: [DecisionImage]?
    public let links: [DecisionLink]?
    /** The page the owner answers on instead of Starbridge; the decision then has no options. */
    public let answerIn: DecisionLink?
    /** The machine takes a typed reply in place of an option. */
    public let replies: Bool?
    /** With `answerIn`: the machine takes a Done answer. */
    public let done: Bool?
    public let dir: DirectoryHead?

    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        to = try f.recipients()
        createdAt = try f.time("createdAt")
        question = try f.text("question", 1, 300)
        context = try f.text("context", 0, 8000)
        options = try f.strings("options")
        try schema(options.count <= 4, "options")
        for o in options { try checkLength(o, 1, 100, "option") }
        recommended = try f.optString("recommended")
        agent = try f.optString("agent")
        if let agent { try checkAgentName(agent, "agent") }
        source = try Source(f.child("source"))
        images = try f.optArray("images").map { items in
            try schema(items.count <= 4, "images")
            return try items.map { try DecisionImage(Fields($0, "images")) }
        }
        links = try f.optArray("links").map { items in
            try schema(items.count <= 4, "links")
            return try items.map { try DecisionLink(Fields($0, "links")) }
        }
        answerIn = try f.optional("answerIn").map { try DecisionLink(Fields($0, "answerIn")) }
        replies = try f.optTrue("replies")
        done = try f.optTrue("done")
        dir = try optDir(f)
        try schema(options.count != 1, "options: 0 or 2 to 4")
        // By code points, as JavaScript compares: Swift's == would equate "é" and "e\u{301}".
        let points = options.map { Array($0.unicodeScalars) }
        try schema(Set(points).count == options.count, "options must be distinct")
        if !options.isEmpty {
            try schema(recommended.map { points.contains(Array($0.unicodeScalars)) } == true, "recommended must be one of the options")
        } else {
            try schema(recommended == nil, "recommended needs options")
        }
        try schema(answerIn == nil || options.isEmpty, "a decision answered elsewhere has no options")
        try schema(done == nil || answerIn != nil, "done needs answerIn")
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "to": JSON(to), "createdAt": .string(createdAt), "question": .string(question), "context": .string(context), "options": JSON(options)]
        o.put("recommended", recommended.map(JSON.string))
        o.put("agent", agent.map(JSON.string))
        o["source"] = source.json
        o.put("images", images.map { .array($0.map(\.json)) })
        o.put("links", links.map { .array($0.map(\.json)) })
        o.put("answerIn", answerIn?.json)
        o.put("replies", replies.map(JSON.bool))
        o.put("done", done.map(JSON.bool))
        o.put("dir", dir?.json)
        return .object(o)
    }
}

public struct Answer: ItemBody, Equatable {
    public let id: String
    public let decisionId: String
    /** The machine that asked. */
    public let to: String
    public let answeredAt: String
    public let choice: String?
    public let text: String?
    /** The owner answered on the decision's `answerIn` page. */
    public let done: Bool?
    public let dir: DirectoryHead?

    public var re: String? { decisionId }
    public var recipients: [String] { [to] }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        decisionId = try f.id("decisionId")
        to = try f.id("to")
        answeredAt = try f.time("answeredAt")
        choice = try f.optText("choice", 0, 100)
        text = try f.optText("text", 0, 4000)
        done = try f.optTrue("done")
        dir = try optDir(f)
        try schema([choice != nil, text != nil, done != nil].filter { $0 }.count == 1, "exactly one of choice, text and done")
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "decisionId": .string(decisionId), "to": .string(to), "answeredAt": .string(answeredAt)]
        o.put("choice", choice.map(JSON.string))
        o.put("text", text.map(JSON.string))
        o.put("done", done.map(JSON.bool))
        o.put("dir", dir?.json)
        return .object(o)
    }
}

// --- Permission prompts -----------------------------------------------------

/** A permission prompt lives at most this long; the server refuses answers after it. */
public let PERMISSION_TTL_MS: Int64 = 10 * 60 * 1000

/** How far an allow reaches: this call, the rest of the session, or always in this project. */
public enum PermissionScope: String, Sendable { case once, session, project }

/** A wider allow the machine offers, shown with the exact rule it would add. */
public struct PermissionSuggestion: Equatable, Sendable {
    public let label: String
    public let rule: String
    public let scope: PermissionScope

    init(_ f: Fields) throws {
        label = try f.text("label", 1, 100)
        rule = try f.text("rule", 1, 500)
        scope = PermissionScope(rawValue: try f.oneOf("scope", ["session", "project"]))!
    }

    var json: JSON { ["label": .string(label), "rule": .string(rule), "scope": .string(scope.rawValue)] }
}

/** An agent waiting at a permission prompt, as the machine shows it to devices. */
public struct Permission: ItemBody, Equatable {
    public let id: String
    public let to: [String]
    public let createdAt: String
    public let agent: String
    public let tool: String
    /** One line: the Bash command, or the edited path. */
    public let summary: String
    public let description: String?
    /** The tool's input as JSON text, with secrets redacted on the machine. */
    public let input: String
    /** The machine's keyed hash of the tool input before redaction; answers repeat it. */
    public let inputHash: String
    public let suggestions: [PermissionSuggestion]
    public let expiresAt: String
    public let source: Source
    public let dir: DirectoryHead?

    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        to = try f.recipients()
        createdAt = try f.time("createdAt")
        agent = try f.string("agent")
        try checkAgentName(agent, "agent")
        tool = try f.text("tool", 1, 100)
        summary = try f.text("summary", 1, 200)
        description = try f.optText("description", 0, 500)
        input = try f.text("input", 0, 8000)
        inputHash = try f.bytes32("inputHash")
        let suggestions = try f.array("suggestions")
        try schema(suggestions.count <= 2, "suggestions")
        self.suggestions = try suggestions.map { try PermissionSuggestion(Fields($0, "suggestions")) }
        expiresAt = try f.time("expiresAt")
        source = try Source(f.child("source"))
        dir = try optDir(f)
        let ttl = epochMillis(expiresAt)! - epochMillis(createdAt)!
        try schema(ttl > 0 && ttl <= PERMISSION_TTL_MS, "expiresAt: after createdAt, at most 10 minutes")
        try schema(Set(self.suggestions.map(\.scope)).count == self.suggestions.count, "one suggestion per scope")
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "to": JSON(to), "createdAt": .string(createdAt), "agent": .string(agent), "tool": .string(tool), "summary": .string(summary)]
        o.put("description", description.map(JSON.string))
        o["input"] = .string(input)
        o["inputHash"] = .string(inputHash)
        o["suggestions"] = .array(suggestions.map(\.json))
        o["expiresAt"] = .string(expiresAt)
        o["source"] = source.json
        o.put("dir", dir?.json)
        return .object(o)
    }
}

/** A device's answer to a permission prompt, bound to its id and its input's hash. */
public struct PermissionAnswer: ItemBody, Equatable {
    public let id: String
    public let permissionId: String
    /** The machine that asked. */
    public let to: String
    public let answeredAt: String
    /** "allow" or "deny". */
    public let behavior: String
    public let scope: PermissionScope
    public let inputHash: String
    /** On a deny: what the agent should do instead. */
    public let message: String?
    public let dir: DirectoryHead?

    public var re: String? { permissionId }
    public var recipients: [String] { [to] }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        permissionId = try f.id("permissionId")
        to = try f.id("to")
        answeredAt = try f.time("answeredAt")
        behavior = try f.oneOf("behavior", ["allow", "deny"])
        scope = PermissionScope(rawValue: try f.oneOf("scope", ["once", "session", "project"]))!
        inputHash = try f.bytes32("inputHash")
        message = try f.optText("message", 0, 500)
        dir = try optDir(f)
        if behavior == "deny" { try schema(scope == .once, "a deny is for this call only") }
        if behavior == "allow" { try schema(message == nil, "message is for a deny") }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "permissionId": .string(permissionId), "to": .string(to), "answeredAt": .string(answeredAt), "behavior": .string(behavior), "scope": .string(scope.rawValue), "inputHash": .string(inputHash)]
        o.put("message", message.map(JSON.string))
        o.put("dir", dir?.json)
        return .object(o)
    }
}

/** The longest reason an agent gives for withdrawing a decision. */
public let SETTLED_REASON_MAX = 120
public let SETTLED_OUTCOMES: Set<String> = ["keyboard", "timeout", "device", "elsewhere", "withdrawn"]

/** The machine's notice that one of its items no longer waits for an answer. */
public struct Settled: ItemBody, Equatable {
    public let id: String
    /** The permission or decision it closes, posted by the same machine. */
    public let itemId: String
    public let to: [String]
    public let at: String
    public let outcome: String?
    /** With outcome "device": the device whose answer the machine applied. */
    public let device: String?
    /** With outcome "device" on a decision: the answer it applied. */
    public let choice: String?
    public let text: String?
    public let dir: DirectoryHead?
    /** With outcome "device" on a permission: what that device answered. */
    public let behavior: String?
    /** With outcome "withdrawn": why the agent no longer needs it, one line. */
    public let reason: String?

    public var re: String? { itemId }
    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        itemId = try f.id("itemId")
        to = try f.recipients()
        at = try f.time("at")
        outcome = try f.optString("outcome")
        if let outcome { try schema(SETTLED_OUTCOMES.contains(outcome), "outcome") }
        device = try f.optId("device")
        choice = try f.optText("choice", 0, 100)
        text = try f.optText("text", 0, 4000)
        dir = try optDir(f)
        behavior = try f.optString("behavior")
        if let behavior { try schema(behavior == "allow" || behavior == "deny", "behavior") }
        reason = try f.optText("reason", 1, SETTLED_REASON_MAX)
        if let reason { try schema(!reason.unicodeScalars.contains { $0 == "\n" || $0 == "\r" }, "reason: one line") }
        try schema(device != nil || (choice == nil && text == nil), "choice and text come only with a device's outcome")
        try schema(choice == nil || text == nil, "at most one of choice and text")
        try schema((outcome == "device") == (device != nil), "device is set exactly when outcome is device")
        try schema(behavior == nil || outcome == "device", "behavior comes only with a device's outcome")
        try schema(reason == nil || outcome == "withdrawn", "reason comes only with outcome withdrawn")
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "itemId": .string(itemId), "to": JSON(to), "at": .string(at)]
        o.put("outcome", outcome.map(JSON.string))
        o.put("device", device.map(JSON.string))
        o.put("choice", choice.map(JSON.string))
        o.put("text", text.map(JSON.string))
        o.put("dir", dir?.json)
        o.put("behavior", behavior.map(JSON.string))
        o.put("reason", reason.map(JSON.string))
        return .object(o)
    }
}

public let WAITING_STATES: Set<String> = ["working", "waiting"]

/**
 * Whether the agent is blocked on one of its machine's decisions. The machine re-posts it under
 * one id per decision; devices keep the one with the latest `at`. None means working.
 */
public struct Waiting: ItemBody, Equatable {
    public let id: String
    public let decisionId: String
    public let to: [String]
    public let at: String
    /** "working" or "waiting". */
    public let state: String
    public let dir: DirectoryHead?

    public var re: String? { decisionId }
    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        decisionId = try f.id("decisionId")
        to = try f.recipients()
        at = try f.time("at")
        state = try f.oneOf("state", WAITING_STATES)
        dir = try optDir(f)
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "decisionId": .string(decisionId), "to": JSON(to), "at": .string(at), "state": .string(state)]
        o.put("dir", dir?.json)
        return .object(o)
    }
}

/** The latest a snooze may run. */
public let SNOOZE_MAX_MS: Int64 = 7 * 24 * 60 * 60 * 1000

/**
 * The owner put a decision off until `until`: not an answer. Sealed to the machine that asked and
 * every active device; the latest `at` wins. `until` at or before `at` brings it back now.
 */
public struct Snooze: ItemBody, Equatable {
    public let id: String
    public let decisionId: String
    public let to: [String]
    public let until: String
    public let at: String
    public let dir: DirectoryHead?

    public var re: String? { decisionId }
    public var recipients: [String] { to }
    public var wakeAt: String? { until }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        decisionId = try f.id("decisionId")
        to = try f.recipients()
        until = try f.time("until")
        at = try f.time("at")
        dir = try optDir(f)
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "decisionId": .string(decisionId), "to": JSON(to), "until": .string(until), "at": .string(at)]
        o.put("dir", dir?.json)
        return .object(o)
    }
}

// --- Runs --------------------------------------------------------------------

/** A machine re-posts a running run at least this often, progress or not. */
public let RUN_HEARTBEAT_MS: Int64 = 60 * 1000
/** A running run with no update for this long has lost its machine: devices stop showing it. */
public let RUN_STALE_MS: Int64 = 3 * RUN_HEARTBEAT_MS
public let RUN_UNITS: Set<String> = ["step", "percent"]

public struct RunProgress: Equatable, Sendable {
    public let done: Int
    public let total: Int
    /** "step" or "percent". */
    public let unit: String

    init(_ f: Fields) throws {
        done = try f.int("done")
        total = try f.int("total")
        try schema(done >= 0 && total >= 1, "progress")
        unit = try f.oneOf("unit", RUN_UNITS)
        try schema(done <= total, "done is at most total")
        try schema(unit == "step" || total == 100, "a percent is out of 100")
    }

    var json: JSON { ["done": JSON(done), "total": JSON(total), "unit": .string(unit)] }
}

public struct RunExit: Equatable, Sendable {
    /** 128 + n when signal n ended it. */
    public let code: Int
    public let at: String

    init(_ f: Fields) throws {
        code = try f.int("code")
        try schema((0...255).contains(code), "exit.code")
        at = try f.time("at")
    }

    var json: JSON { ["code": JSON(code), "at": .string(at)] }
}

/** A command an agent wrapped in `starbridge run`, re-posted under its id as it changes. */
public struct Run: ItemBody, Equatable {
    public let id: String
    public let to: [String]
    public let title: String
    /** Why the owner hears of it, e.g. "uses your session and keyboard". */
    public let reason: String
    public let source: Source
    public let startedAt: String
    /** When the machine sent this update. */
    public let at: String
    public let progress: RunProgress?
    /** Set once the command exited. */
    public let exit: RunExit?
    public let dir: DirectoryHead?

    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        to = try f.recipients()
        title = try f.text("title", 1, 100)
        reason = try f.text("reason", 1, 200)
        source = try Source(f.child("source"))
        startedAt = try f.time("startedAt")
        at = try f.time("at")
        progress = try f.optional("progress").map { try RunProgress(Fields($0, "progress")) }
        exit = try f.optional("exit").map { try RunExit(Fields($0, "exit")) }
        dir = try optDir(f)
        let started = epochMillis(startedAt)!
        try schema(epochMillis(at)! >= started, "at: not before startedAt")
        if let exit { try schema(epochMillis(exit.at)! >= started, "exit.at: not before startedAt") }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "to": JSON(to), "title": .string(title), "reason": .string(reason), "source": source.json, "startedAt": .string(startedAt), "at": .string(at)]
        o.put("progress", progress?.json)
        o.put("exit", exit?.json)
        o.put("dir", dir?.json)
        return .object(o)
    }
}

// --- Quotas ------------------------------------------------------------------

public let PACE_STAGES: Set<String> = ["ahead", "on-track", "behind", "unknown"]
public let ALERT_KINDS: Set<String> = ["unused-headroom", "runs-out", "low"]

/** Where usage is heading at the current rate. Percent values are rounded to 0.1. */
public struct Pace: Equatable, Sendable {
    public let stage: String
    public let expectedUsedPercent: Double
    public let deltaPercent: Double
    public let projectedUsedPercent: Double?
    public let willLastToReset: Bool
    public let runsOutAt: String?

    public init(stage: String, expectedUsedPercent: Double, deltaPercent: Double, projectedUsedPercent: Double?, willLastToReset: Bool, runsOutAt: String?) {
        self.stage = stage
        self.expectedUsedPercent = expectedUsedPercent
        self.deltaPercent = deltaPercent
        self.projectedUsedPercent = projectedUsedPercent
        self.willLastToReset = willLastToReset
        self.runsOutAt = runsOutAt
    }

    init(_ f: Fields) throws {
        stage = try f.oneOf("stage", PACE_STAGES)
        expectedUsedPercent = try f.number("expectedUsedPercent")
        deltaPercent = try f.number("deltaPercent")
        projectedUsedPercent = try f.nullable("projectedUsedPercent").map { v in
            guard let n = v.number, n.isFinite else { throw ProtocolError(.badSchema, "projectedUsedPercent") }
            return n
        }
        willLastToReset = try f.bool("willLastToReset")
        runsOutAt = try f.nullable("runsOutAt").map { try asString($0, "runsOutAt") }
        if let runsOutAt { try checkTime(runsOutAt, "runsOutAt") }
    }

    public var json: JSON {
        ["stage": .string(stage), "expectedUsedPercent": .number(expectedUsedPercent), "deltaPercent": .number(deltaPercent),
         "projectedUsedPercent": projectedUsedPercent.map(JSON.number) ?? .null, "willLastToReset": .bool(willLastToReset),
         "runsOutAt": runsOutAt.map(JSON.string) ?? .null]
    }
}

public struct QuotaWindow: Equatable, Sendable {
    /** CodexBar's key: "primary", "secondary" or an extra window's id. */
    public let id: String
    public let label: String
    public let usedPercent: Double
    public let windowMinutes: Int?
    public let resetsAt: String?
    public let pace: Pace?

    public init(id: String, label: String, usedPercent: Double, windowMinutes: Int?, resetsAt: String?, pace: Pace?) {
        self.id = id
        self.label = label
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetsAt = resetsAt
        self.pace = pace
    }

    init(_ f: Fields) throws {
        id = try f.text("id", 1, 100)
        label = try f.text("label", 0, 100)
        usedPercent = try f.number("usedPercent")
        try schema(usedPercent >= 0, "usedPercent")
        windowMinutes = try f.nullable("windowMinutes").map { try asInt($0, "windowMinutes") }
        if let windowMinutes { try schema(windowMinutes > 0, "windowMinutes") }
        resetsAt = try f.nullable("resetsAt").map { try asString($0, "resetsAt") }
        if let resetsAt { try checkTime(resetsAt, "resetsAt") }
        pace = try f.nullable("pace").map { try Pace(Fields($0, "pace")) }
    }

    public var json: JSON {
        ["id": .string(id), "label": .string(label), "usedPercent": .number(usedPercent), "windowMinutes": windowMinutes.map { JSON($0) } ?? .null,
         "resetsAt": resetsAt.map(JSON.string) ?? .null, "pace": pace?.json ?? .null]
    }
}

/**
 * A window the uploader alerts on. It repeats in every snapshot while it holds; `notify` marks the
 * one snapshot that first raised it in this window's cycle.
 */
public struct QuotaAlert: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /** Percent left unused at reset at the current rate. */
        case unusedHeadroom(unusedPercent: Double)
        case runsOut(runsOutAt: String)
        /** At most `threshold` percent left. */
        case low(threshold: Int)

        public var name: String {
            switch self {
            case .unusedHeadroom: "unused-headroom"
            case .runsOut: "runs-out"
            case .low: "low"
            }
        }
    }

    public let kind: Kind
    public let provider: String
    public let window: String
    public let resetsAt: String
    public let notify: Bool?

    public init(kind: Kind, provider: String, window: String, resetsAt: String, notify: Bool? = nil) {
        self.kind = kind
        self.provider = provider
        self.window = window
        self.resetsAt = resetsAt
        self.notify = notify
    }

    init(_ f: Fields) throws {
        switch try f.string("kind") {
        case "unused-headroom": kind = .unusedHeadroom(unusedPercent: try f.number("unusedPercent"))
        case "runs-out": kind = .runsOut(runsOutAt: try f.time("runsOutAt"))
        case "low":
            let t = try f.int("threshold")
            try schema((1...99).contains(t), "threshold")
            kind = .low(threshold: t)
        default: throw ProtocolError(.badSchema, "alert kind")
        }
        provider = try f.string("provider")
        window = try f.string("window")
        resetsAt = try f.time("resetsAt")
        notify = try f.optTrue("notify")
    }

    public var json: JSON {
        var o: JSONObject = ["kind": .string(kind.name), "provider": .string(provider), "window": .string(window), "resetsAt": .string(resetsAt)]
        o.put("notify", notify.map(JSON.bool))
        switch kind {
        case .unusedHeadroom(let p): o["unusedPercent"] = .number(p)
        case .runsOut(let at): o["runsOutAt"] = .string(at)
        case .low(let t): o["threshold"] = JSON(t)
        }
        return .object(o)
    }
}

public struct QuotaProvider: Equatable, Sendable {
    public let provider: String
    public let account: String?
    public let windows: [QuotaWindow]
    /** Set when CodexBar failed for this provider. */
    public let error: String?
    /** With `error`: when `windows` were read, the last time CodexBar did not fail. */
    public let updatedAt: String?

    init(_ f: Fields) throws {
        provider = try f.text("provider", 1, 100)
        account = try f.optText("account", 0, 200)
        windows = try f.array("windows").map { try QuotaWindow(Fields($0, "windows")) }
        error = try f.optText("error", 0, 1000)
        updatedAt = try f.optTime("updatedAt")
    }

    var json: JSON {
        var o: JSONObject = ["provider": .string(provider)]
        o.put("account", account.map(JSON.string))
        o["windows"] = .array(windows.map(\.json))
        o.put("error", error.map(JSON.string))
        o.put("updatedAt", updatedAt.map(JSON.string))
        return .object(o)
    }
}

public struct QuotaSnapshot: ItemBody, Equatable {
    public let id: String
    public let to: [String]
    public let takenAt: String
    public let providers: [QuotaProvider]
    public let alerts: [QuotaAlert]
    public let dir: DirectoryHead?

    public var recipients: [String] { to }

    init(_ f: Fields) throws {
        try f.version()
        id = try f.id("id")
        to = try f.recipients()
        takenAt = try f.time("takenAt")
        providers = try f.array("providers").map { try QuotaProvider(Fields($0, "providers")) }
        alerts = try f.array("alerts").map { try QuotaAlert(Fields($0, "alerts")) }
        dir = try optDir(f)
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "id": .string(id), "to": JSON(to), "takenAt": .string(takenAt), "providers": .array(providers.map(\.json)), "alerts": .array(alerts.map(\.json))]
        o.put("dir", dir?.json)
        return .object(o)
    }
}

// --- Parsing a body ----------------------------------------------------------

/** A parsed body of any kind. */
public enum Body: Sendable {
    case directory(DirectoryEntry)
    case item(any ItemBody)

    public var item: (any ItemBody)? {
        if case .item(let b) = self { b } else { nil }
    }
}

/** A body checked against its kind's schema alone, as writers check theirs. */
func parseStrict(_ kind: String, _ json: JSON) throws -> Body {
    let f = { try Fields(json, "") }
    switch kind {
    case "directory": return .directory(try DirectoryEntry(json: json))
    case "decision": return .item(try Decision(f()))
    case "answer": return .item(try Answer(f()))
    case "quota": return .item(try QuotaSnapshot(f()))
    case "permission": return .item(try Permission(f()))
    case "permission-answer": return .item(try PermissionAnswer(f()))
    case "settled": return .item(try Settled(f()))
    case "run": return .item(try Run(f()))
    case "waiting": return .item(try Waiting(f()))
    case "snooze": return .item(try Snooze(f()))
    default: throw ProtocolError(.wrongKind, kind)
    }
}

/** Parses a body whose signature was already checked, as a reader (`readable`). */
public func parseBody(_ kind: String, _ text: String) throws -> Body {
    let json: JSON
    do {
        json = try JSON.parse(text)
    } catch {
        throw ProtocolError(.badSchema, "body is not JSON")
    }
    return try parseStrict(kind, readable(kind, json))
}

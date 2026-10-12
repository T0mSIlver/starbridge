// packages/protocol/src/join.ts. Joining by digits: a device signed in to the account asks to
// join, and the owner approves it from a device the account already has by checking that both
// screens show the same 6 digits. The digits are a short authentication string with a commitment,
// as in ZRTP: the joining device commits to its ephemeral key before it sees the approver's, so
// a server in the middle gets one guess in a million per attempt.

public struct JoinRequestBody: Equatable, Sendable {
    /** 8 Crockford base32 characters, chosen by the joining device. */
    public let join: String
    public let account: String
    public let id: String
    public let name: String
    public let boxPk: String
    public let signPk: String
    public let at: String

    public init(join: String, account: String, id: String, name: String, boxPk: String, signPk: String, at: String) {
        self.join = join
        self.account = account
        self.id = id
        self.name = name
        self.boxPk = boxPk
        self.signPk = signPk
        self.at = at
    }

    public init(json: JSON) throws {
        let f = try Fields(json, "")
        try f.version()
        join = try f.string("join")
        let chars = Array(join)
        try schema(chars.count == 8 && join.utf8.count == 8 && chars.allSatisfy(Crockford.alphabet.contains), "join")
        account = try f.id("account")
        id = try f.id("id")
        name = try f.text("name", 1, 100)
        boxPk = try f.bytes32("boxPk")
        signPk = try f.bytes32("signPk")
        at = try f.time("at")
    }

    public var json: JSON {
        ["v": 1, "join": .string(join), "account": .string(account), "id": .string(id), "name": .string(name), "boxPk": .string(boxPk), "signPk": .string(signPk), "at": .string(at)]
    }
}

public struct JoinApprovalBody: Equatable, Sendable {
    public let join: String
    public let account: String
    /** The directory up to and including the new device's entry. */
    public let length: Int
    public let head: String
    public let approver: String

    public init(join: String, account: String, length: Int, head: String, approver: String) {
        self.join = join
        self.account = account
        self.length = length
        self.head = head
        self.approver = approver
    }

    public init(json: JSON) throws {
        let f = try Fields(json, "")
        try f.version()
        join = try f.text("join", 8, 8)
        account = try f.id("account")
        length = try f.int("length")
        try schema(length > 0, "length")
        head = try f.bytes32("head")
        approver = try f.id("approver")
    }

    public var json: JSON {
        ["v": 1, "join": .string(join), "account": .string(account), "length": JSON(length), "head": .string(head), "approver": .string(approver)]
    }

    public var pin: Pin { Pin(length: length, head: head) }
}

/** What a join derives once both ephemeral keys are known. */
public struct JoinKeys: Sendable {
    /** Keys the approval's `crypto_auth`. */
    let mac: SecretKey
    /** Six decimal digits, shown on both devices. */
    public let digits: String

    /** The MAC key's bytes, for tests that compare it with the vectors. */
    var macBytes: [UInt8] { mac.bytes }
}

public enum Joins {
    public static func newJoinId() -> String { Crockford.encode(Sodium.randomBytes(5)) }

    /** A fresh X25519 key pair for one join; never reused. */
    public static func newKeyPair() -> KeyPair { Sodium.boxKeyPair() }

    /** The request text the joining device posts: JSON of the checked body. */
    public static func request(_ body: JoinRequestBody) throws -> String {
        try JoinRequestBody(json: body.json).json.text
    }

    /** Parses the posted request text; the approver shows its name and adds its keys. */
    public static func openRequest(_ request: String) throws -> JoinRequestBody {
        let value: JSON
        do {
            value = try JSON.parse(request)
        } catch {
            throw ProtocolError(.badSchema, "request is not JSON")
        }
        return try JoinRequestBody(json: value)
    }

    /** BLAKE2b-256 of "starbridge/v1/join-commit", NUL, the joiner's key, the request text. */
    public static func commitment(joinerKey: [UInt8], request: String) -> String {
        toB64(Sodium.hash(label("join-commit") + joinerKey + utf8(request)))
    }

    private static func key32(_ b64: String, _ what: String) throws -> [UInt8] {
        let k = try fromB64(b64)
        if k.count != 32 { throw ProtocolError(.badEncoding, "\(what) is not 32 bytes") }
        return k
    }

    private static func derive(_ mine: KeyPair, peer: [UInt8], joinerKey: [UInt8], approverKey: [UInt8], request: String) throws -> JoinKeys {
        // libsodium refuses a result of all zeros: the peer sent a low-order point.
        guard let shared = Sodium.scalarMult(mine.secretKey, peer) else {
            throw ProtocolError(.badKey, "the other side's key is not usable")
        }
        let zero = shared.withUnsafeBytes { $0.allSatisfy { $0 == 0 } }
        if zero { throw ProtocolError(.badKey, "all-zero shared secret") }
        let transcript = joinerKey + approverKey + utf8(request)
        let mac = Sodium.hash(label("join-mac") + transcript, key: shared)
        let sas = Sodium.hash(label("join-sas") + transcript, key: shared)
        let n = sas.withUnsafeBytes { UInt32($0[0]) << 24 | UInt32($0[1]) << 16 | UInt32($0[2]) << 8 | UInt32($0[3]) }
        let digits = String(n % 1_000_000)
        return JoinKeys(mac: mac, digits: String(repeating: "0", count: 6 - digits.count) + digits)
    }

    /**
     * The joining device, once the approver's key arrived. It reveals its own key only after
     * this, and only once per join: a second approver key for the same join is refused by the caller.
     */
    public static func joinerKeys(mine: KeyPair, approverKey: String, request: String) throws -> JoinKeys {
        let approver = try key32(approverKey, "approver key")
        return try derive(mine, peer: approver, joinerKey: mine.publicKey, approverKey: approver, request: request)
    }

    /** The approving device, once the joiner revealed its key: it must open the commitment. */
    public static func approverKeys(mine: KeyPair, joinerKey: String, request: String, commitment: String) throws -> JoinKeys {
        let joiner = try key32(joinerKey, "joiner key")
        let expected = Sodium.hash(label("join-commit") + joiner + utf8(request))
        guard let given = try? fromB64(commitment), constantTimeEqual(expected, given) else {
            throw ProtocolError(.badCommitment, "the revealed key does not match the commitment")
        }
        return try derive(mine, peer: joiner, joinerKey: joiner, approverKey: mine.publicKey, request: request)
    }

    private static func approvalMessage(_ body: String) -> [UInt8] { label("join-approval") + utf8(body) }

    /** Made by the approver once the new device's entry is in the directory. */
    public static func approval(_ body: JoinApprovalBody, keys: JoinKeys) throws -> PairingMessage {
        let text = try JoinApprovalBody(json: body.json).json.text
        let mac = Sodium.auth(approvalMessage(text), key: keys.mac)
        return PairingMessage(body: text, mac: toB64(mac))
    }

    /** Checked by the joining device; it then verifies the directory with `pin` as pin. */
    public static func openApproval(_ msg: JSON, keys: JoinKeys, join: String) throws -> JoinApprovalBody {
        let m = try PairingMessage(json: msg)
        let ok = (try? Sodium.authVerify(fromB64(m.mac), approvalMessage(m.body), key: keys.mac)) ?? false
        if !ok { throw ProtocolError(.badMac, "join-approval") }
        let value: JSON
        do {
            value = try JSON.parse(m.body)
        } catch {
            throw ProtocolError(.badSchema, "body is not JSON")
        }
        let body = try JoinApprovalBody(json: value)
        if body.join != join { throw ProtocolError(.idMismatch, "join") }
        return body
    }

    /** "123 456": the digits as both screens show them. */
    public static func formatDigits(_ digits: String) -> String { "\(digits.prefix(3)) \(digits.dropFirst(3))" }
}

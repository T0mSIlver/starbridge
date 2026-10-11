// packages/protocol/src/pairing.ts. Pairing joins a new member (a machine, or another device) to
// the directory. The new member shows a 24-character code: 8 characters of rendezvous id, which
// the server sees, and 16 characters (80 bits) of secret, which never reaches the server. Both
// sides authenticate their messages with a key derived from the secret, so the server can neither
// swap the new member's keys nor hand the new member a directory of its own.

public enum Crockford {
    public static let alphabet: [Character] = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    public static func encode(_ bytes: [UInt8]) -> String {
        var bits = 0
        var value: UInt32 = 0
        var out = ""
        for b in bytes {
            value = value << 8 | UInt32(b)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[Int(value >> UInt32(bits - 5) & 31)])
                bits -= 5
            }
            value &= (1 << UInt32(bits)) - 1
        }
        if bits > 0 { out.append(alphabet[Int(value << UInt32(5 - bits) & 31)]) }
        return out
    }

    /** Characters from the alphabet to bytes, MSB first; bits past the last whole byte drop. */
    public static func decode(_ chars: [Character]) throws -> [UInt8] {
        var out: [UInt8] = []
        var bits = 0
        var value: UInt32 = 0
        for c in chars {
            guard let v = alphabet.firstIndex(of: c) else { throw ProtocolError(.badEncoding, "not Crockford base32") }
            value = value << 5 | UInt32(v)
            bits += 5
            if bits >= 8 {
                out.append(UInt8(value >> UInt32(bits - 8) & 0xFF))
                bits -= 8
            }
            value &= (1 << UInt32(bits)) - 1
        }
        return out
    }

    /** Upper case without whitespace and dashes; O reads as 0, I and L as 1. */
    static func normalize(_ text: String) -> [Character] {
        // JavaScript's \s, which the TypeScript strips with /[\s-]/g.
        let space: Set<Unicode.Scalar> = [
            "\t", "\n", "\u{0B}", "\u{0C}", "\r", " ", "\u{A0}", "\u{1680}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        var scalars = String.UnicodeScalarView()
        for u in text.uppercased().unicodeScalars where u != "-" && !space.contains(u) && !(0x2000...0x200A).contains(u.value) {
            scalars.append(u == "O" ? "0" : u == "I" || u == "L" ? "1" : u)
        }
        return Array(String(scalars))
    }
}

public struct PairingCode: Equatable, Sendable {
    public let rendezvous: String
    public let secret: String

    init(_ chars: String) {
        rendezvous = String(chars.prefix(8))
        secret = String(chars.dropFirst(8).prefix(16))
    }

    public static func generate() -> PairingCode { PairingCode(Crockford.encode(Sodium.randomBytes(15))) }

    /** "ABCD-EFGH-…", six groups of four. */
    public var formatted: String { groups(Array(rendezvous + secret)) }

    /** Accepts any case, dashes and spaces, and Crockford's look-alikes. */
    public static func parse(_ text: String) throws -> PairingCode {
        let chars = Crockford.normalize(text)
        guard chars.count == 24, chars.allSatisfy(Crockford.alphabet.contains) else {
            throw ProtocolError(.badEncoding, "pairing code must be 24 Crockford base32 characters")
        }
        return PairingCode(String(chars))
    }

    /** A code typed by hand, or read from a scanned pairing link: the part after `#` if any. */
    public static func fromLink(_ text: String) throws -> PairingCode {
        if let hash = text.firstIndex(of: "#") { return try parse(String(text[text.index(after: hash)...])) }
        return try parse(text)
    }
}

func groups(_ chars: [Character]) -> String {
    stride(from: 0, to: chars.count - chars.count % 4, by: 4).map { String(chars[$0..<$0 + 4]) }.joined(separator: "-")
}

private func trimSlashes(_ server: String) -> String {
    var s = Substring(server)
    while s.hasSuffix("/") { s = s.dropLast() }
    return String(s)
}

/** encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) as UTF-8 percent escapes. */
func encodeURIComponent(_ s: String) -> String {
    let keep = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    var out = ""
    for b in s.utf8 {
        if keep.contains(b) {
            out.unicodeScalars.append(Unicode.Scalar(b))
        } else {
            let hex = String(b, radix: 16, uppercase: true)
            out += "%" + (hex.count == 1 ? "0" : "") + hex
        }
    }
    return out
}

public struct PairingRequestBody: Equatable, Sendable {
    public let rendezvous: String
    public let role: Role
    public let id: String
    public let name: String
    public let boxPk: String
    public let signPk: String
    public let at: String

    public init(rendezvous: String, role: Role, id: String, name: String, boxPk: String, signPk: String, at: String) {
        self.rendezvous = rendezvous
        self.role = role
        self.id = id
        self.name = name
        self.boxPk = boxPk
        self.signPk = signPk
        self.at = at
    }

    init(json: JSON) throws {
        let f = try Fields(json, "")
        try f.version()
        rendezvous = try f.text("rendezvous", 8, 8)
        role = Role(rawValue: try f.oneOf("role", ["device", "machine"]))!
        id = try f.id("id")
        name = try f.text("name", 1, 100)
        boxPk = try f.bytes32("boxPk")
        signPk = try f.bytes32("signPk")
        at = try f.time("at")
    }

    public var json: JSON {
        ["v": 1, "rendezvous": .string(rendezvous), "role": .string(role.rawValue), "id": .string(id), "name": .string(name), "boxPk": .string(boxPk), "signPk": .string(signPk), "at": .string(at)]
    }
}

public struct PairingApprovalBody: Equatable, Sendable {
    public let rendezvous: String
    public let account: String
    /** The directory up to and including the new member's entry. */
    public let length: Int
    public let head: String
    public let approver: String
    /** `checkProof` of the new machine's `add` entry, when the approver scanned its QR. */
    public let check: String?

    public init(rendezvous: String, account: String, length: Int, head: String, approver: String, check: String? = nil) {
        self.rendezvous = rendezvous
        self.account = account
        self.length = length
        self.head = head
        self.approver = approver
        self.check = check
    }

    init(json: JSON) throws {
        let f = try Fields(json, "")
        try f.version()
        rendezvous = try f.text("rendezvous", 8, 8)
        account = try f.id("account")
        length = try f.int("length")
        try schema(length > 0, "length")
        head = try f.bytes32("head")
        approver = try f.id("approver")
        check = try f.optString("check")
        if let check { try checkBytes(check, 43, "check") }
    }

    public var json: JSON {
        var o: JSONObject = ["v": 1, "rendezvous": .string(rendezvous), "account": .string(account), "length": JSON(length), "head": .string(head), "approver": .string(approver)]
        o.put("check", check.map(JSON.string))
        return .object(o)
    }

    public var pin: Pin { Pin(length: length, head: head) }
}

/** A pairing or join message: JSON body text plus its HMAC-SHA-512-256 (`crypto_auth`). */
public struct PairingMessage: Equatable, Sendable {
    public let body: String
    public let mac: String

    public init(json: JSON) throws {
        let f = try Fields(json, "message")
        body = try f.string("body")
        mac = try f.bytes32("mac")
    }

    init(body: String, mac: String) {
        self.body = body
        self.mac = mac
    }

    public var json: JSON { ["body": .string(body), "mac": .string(mac)] }
}

/** A machine's check code and check key (#795), and the code it pairs with. */
public enum Pairings {
    /**
     * How long a machine waits for its owner to confirm its check code, from its approval. Devices
     * show the code beside the machine only this long after its `add` entry.
     */
    public static let checkConfirmMs: Int64 = 10 * 60_000

    /** `<server>/pair#<code>`: the link `starbridge pair` prints and a device's QR carries. */
    public static func link(server: String, code: PairingCode) -> String {
        "\(trimSlashes(server))/pair#\(code.formatted)"
    }

    /** `starbridge://pair?server=<server>&k=<check key>#<code>`, a machine's QR for the apps alone. */
    public static func appLink(server: String, code: PairingCode, checkKey: String) -> String {
        "starbridge://pair?server=\(encodeURIComponent(trimSlashes(server)))&k=\(checkKey)#\(code.formatted)"
    }

    /** A machine's check key: 16 Crockford base32 characters, 80 bits, carried only by its QR code. */
    public static func newCheckKey() -> String { Crockford.encode(Sodium.randomBytes(10)) }

    /** The check key in a scanned link's query (`k=`, before any `#`), or nil. */
    public static func checkKey(fromLink text: String) -> String? {
        let head = text.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let q = head.firstIndex(of: "?") else { return nil }
        for part in head[head.index(after: q)...].split(separator: "&", omittingEmptySubsequences: false) where part.hasPrefix("k=") {
            let key = Array(String(part.dropFirst(2)).uppercased())
            return key.count == 16 && key.allSatisfy(Crockford.alphabet.contains) ? String(key) : nil
        }
        return nil
    }

    /** The new member's claim secret, sent as `X-Claim`: 32 random bytes, base64url. */
    public static func newClaimSecret() -> String { toB64(Sodium.randomBytes(32)) }

    /** BLAKE2b-256 of the claim secret's text, base64url: `claimHash` in `POST /pairings`. */
    public static func claimHash(_ secret: String) -> String { toB64(Sodium.hash(utf8(secret))) }

    /** BLAKE2b-256 of "starbridge/v1/pairing-key", NUL, the 16 secret characters. */
    public static func key(_ code: PairingCode) -> SecretKey {
        Sodium.secretHash(label("pairing-key") + utf8(code.secret))
    }

    private static func authenticate(_ kind: String, _ body: JSON, _ code: PairingCode) -> PairingMessage {
        let text = body.text
        let k = key(code)
        return PairingMessage(body: text, mac: toB64(Sodium.auth(label(kind) + utf8(text), key: k)))
    }

    private static func check(_ kind: String, _ msg: JSON, _ code: PairingCode) throws -> JSON {
        let m = try PairingMessage(json: msg)
        let k = key(code)
        let ok = (try? Sodium.authVerify(fromB64(m.mac), label(kind) + utf8(m.body), key: k)) ?? false
        if !ok { throw ProtocolError(.badMac, kind) }
        do {
            return try JSON.parse(m.body)
        } catch {
            throw ProtocolError(.badSchema, "body is not JSON")
        }
    }

    /** Made by the new member and posted to the server under the rendezvous id. */
    public static func request(_ body: PairingRequestBody, code: PairingCode) throws -> PairingMessage {
        guard body.rendezvous == code.rendezvous else { throw UsageError("rendezvous differs from the code") }
        return authenticate("pairing-request", try PairingRequestBody(json: body.json).json, code)
    }

    /** Checked by the approving device after the owner types the code. */
    public static func openRequest(_ msg: JSON, code: PairingCode) throws -> PairingRequestBody {
        let body = try PairingRequestBody(json: check("pairing-request", msg, code))
        if body.rendezvous != code.rendezvous { throw ProtocolError(.idMismatch, "rendezvous") }
        return body
    }

    /** Made by the approving device once the new member's entry is in the directory. */
    public static func approval(_ body: PairingApprovalBody, code: PairingCode) throws -> PairingMessage {
        authenticate("pairing-approval", try PairingApprovalBody(json: body.json).json, code)
    }

    /** Checked by the new member; it then verifies the directory with `pin` as pin. */
    public static func openApproval(_ msg: JSON, code: PairingCode) throws -> PairingApprovalBody {
        let body = try PairingApprovalBody(json: check("pairing-approval", msg, code))
        if body.rendezvous != code.rendezvous { throw ProtocolError(.idMismatch, "rendezvous") }
        return body
    }

    /** After pairing: the verified directory must hold the new member, active, with its own keys. */
    public static func checkJoined(_ dir: Directory, id: String, role: Role, boxPk: String, signPk: String) throws {
        guard let e = dir.members[id], e.active, e.member.role == role, e.member.boxPk == boxPk, e.member.signPk == signPk else {
            throw ProtocolError(.unknownMember, "the directory does not hold my keys")
        }
    }

    // --- Binding a new session -----------------------------------------------

    /**
     * What a device signs to bind a fresh session to its member, after signing in again:
     * "starbridge/v1/bind", NUL, account, NUL, member id, NUL, the server's nonce.
     */
    public static func bindMessage(account: String, member: String, nonce: String) -> [UInt8] {
        concat(label("bind"), utf8(account), [0], utf8(member), [0], utf8(nonce))
    }

    /** True when `signPk` signed this binding. */
    public static func verifyBind(account: String, member: String, nonce: String, sig: String, signPk: String) -> Bool {
        guard let s = try? fromB64(sig), let pk = try? fromB64(signPk) else { return false }
        return Sodium.verify(s, bindMessage(account: account, member: member, nonce: nonce), publicKey: pk)
    }

    // --- Check codes ---------------------------------------------------------

    /** "starbridge/v1/check" NUL body NUL sig of member `id`'s `add` entry. */
    private static func checkInput(_ entries: [JSON], _ id: String) throws -> [UInt8] {
        for e in entries {
            guard let body = e["body"]?.string, let sig = e["sig"]?.string else { continue }
            let parsed = (try? JSON.parse(body))?.object
            guard parsed?["op"] == "add", parsed?["member"]?["id"] == .string(id) else { continue }
            return concat(label("check"), utf8(body), [0], utf8(sig))
        }
        throw ProtocolError(.unknownMember, "no add entry for \(id)")
    }

    /**
     * A machine's check code, which the owner compares with the code a device shows beside it:
     * the first 80 bits of BLAKE2b-256 of the `add` entry that added member `id`, as 16 Crockford
     * base32 characters in groups of four.
     */
    public static func checkCode(_ entries: [JSON], id: String) throws -> String {
        let hash = Sodium.hash(try checkInput(entries, id))
        return groups(Array(Crockford.encode(Array(hash[0..<10]))))
    }

    private static func checkKeyBytes(_ key: String) -> SecretKey { Sodium.secretHash(label("check-key") + utf8(key)) }

    /** The approval's `check`, from a device that read the machine's check key from its QR. */
    public static func checkProof(_ entries: [JSON], id: String, key: String) throws -> String {
        let k = checkKeyBytes(key)
        return toB64(Sodium.auth(try checkInput(entries, id), key: k))
    }

    /** True when `proof` is `checkProof` of member `id`'s `add` entry in `entries` under `key`. */
    public static func verifyCheckProof(_ entries: [JSON], id: String, key: String, proof: String) -> Bool {
        let k = checkKeyBytes(key)
        guard let input = try? checkInput(entries, id), let tag = try? fromB64(proof) else { return false }
        return Sodium.authVerify(tag, input, key: k)
    }
}

import Foundation
@testable import StarbridgeProtocol
import XCTest

// Every case in packages/protocol/vectors, against the Swift port. The TypeScript and Kotlin
// tests run the same files, so the three agree byte for byte.

private let vectorsDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("../../packages/protocol/vectors").standardizedFileURL

/** The vector files these tests read; `testEveryVectorFileIsRead` keeps it whole. */
private let READ: Set<String> = [
    "context.json", "directory.json", "envelopes.json", "heads.json", "images.json", "join.json",
    "keys.json", "pairing.json", "quota-alerts.json", "schemas.json",
]

/** Vector files only the machine's code runs: the local agent computes pace and alerts (#1147). */
private let MACHINE_ONLY: Set<String> = ["pace.json"]

private func vectors(_ name: String) throws -> JSON {
    try JSON.parse(String(decoding: Data(contentsOf: vectorsDir.appendingPathComponent(name)), as: UTF8.self))
}

private func code(_ fn: () throws -> Void) -> String {
    do {
        try fn()
        return "ok"
    } catch let e as ProtocolError {
        return e.code.rawValue
    } catch {
        return "\(error)"
    }
}

extension JSON {
    func str(_ key: String) -> String { self[key]!.string! }
    func opt(_ key: String) -> JSON? { self[key].flatMap { $0.isNull ? nil : $0 } }
    var items: [JSON] { array! }
}

final class ProtocolVectorsTests: XCTestCase {
    var keys: JSON!
    var directory: JSON!

    override func setUpWithError() throws {
        keys = try vectors("keys.json")
        directory = try vectors("directory.json")
    }

    func member(_ id: String) -> JSON { keys["members"]!.items.first { $0.str("id") == id }! }

    func boxKeys(_ id: String) throws -> KeyPair {
        let m = member(id)
        return KeyPair(publicKey: try fromB64(m.str("boxPk")), secretKey: SecretKey(try fromB64(m.str("boxSk"))))
    }

    func signKey(_ id: String) throws -> SecretKey { SecretKey(try fromB64(member(id).str("signSk"))) }

    /** directory.json's first chain: phone, devbox, browser. */
    func firstDirectory() throws -> Directory {
        try Directories.verify(directory["cases"]!.items[0]["entries"]!.items)
    }

    func testEveryVectorFileIsRead() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: vectorsDir.path).filter { $0.hasSuffix(".json") }
        XCTAssertEqual(Set(files), READ.union(MACHINE_ONLY), "a vector file this port does not test")
    }

    func testDirectory() throws {
        for c in directory["cases"]!.items {
            let name = c.str("name")
            let o = c.opt("options")
            let pin = o?.opt("pin").map { Pin(length: Int($0["length"]!.number!), head: $0.str("head")) }
            let run = { try Directories.verify(c["entries"]!.items, account: o?.opt("account")?.string, pin: pin, recoveryPk: o?.opt("recoveryPk")?.string) }
            let expect = c["expect"]!
            if let error = expect.opt("error") {
                XCTAssertEqual(code { _ = try run() }, error.string!, name)
                continue
            }
            let dir = try run()
            XCTAssertEqual(dir.length, Int(expect["length"]!.number!), name)
            XCTAssertEqual(dir.head, expect.str("head"), name)
            let ids = { (active: Bool) in dir.entries.filter { $0.active == active }.map(\.member.id) }
            XCTAssertEqual(ids(true), expect["active"]!.items.map(\.string!), name)
            XCTAssertEqual(ids(false), expect["revoked"]!.items.map(\.string!), name)
            XCTAssertEqual(dir.recoveryPk, expect.str("recoveryPk"), name)
        }
    }

    func testHeads() throws {
        let v = try vectors("heads.json")
        let chains = v["chains"]!
        func heads(_ j: JSON) throws -> Heads {
            var h = Heads()
            for (k, head) in j.object! { h[k] = try DirectoryHead(json: head) }
            return h
        }
        func json(_ h: Heads) -> JSON { .object(JSONObject(h.map { ($0, $1.json) })) }
        for c in v["withheld"]!.items {
            let entries = chains[c.str("chain")]!.items
            let held = HeadBook.withheld(try heads(c["heads"]!), dir: try Directories.verify(entries), entries: entries)
            let got: JSON = held.map { h in
                var o: JSONObject = ["id": .string(h.id)]
                o.put("by", h.by.map(JSON.string))
                o["head"] = h.head.json
                o.put("revoked", h.revoked.map { ["id": .string($0.id), "by": .string($0.by), "at": .string($0.at)] })
                return .object(o)
            } ?? .null
            XCTAssertEqual(got, c["expect"]!, c.str("name"))
        }
        for c in v["noteHead"]!.items {
            let entries = chains[c.str("chain")]!.items
            var h = try heads(c["heads"]!)
            let changed = HeadBook.note(&h, signer: c.str("signer"), head: try DirectoryHead(json: c["head"]!), entries: entries, dir: try Directories.verify(entries))
            XCTAssertEqual(changed, c["expect"]!["changed"]!.bool!, c.str("name"))
            XCTAssertEqual(json(h), c["expect"]!["heads"]!, c.str("name"))
        }
        for c in v["forgetHeads"]!.items {
            var h = try heads(c["heads"]!)
            HeadBook.forget(&h, id: c.str("id"))
            XCTAssertEqual(json(h), c["expect"]!, c.str("name"))
        }
    }

    func testEnvelopes() throws {
        let v = try vectors("envelopes.json")
        for c in v["signatures"]!.items {
            XCTAssertEqual(code { try Envelopes.verify(SignedEnvelope(json: c["envelope"]!), signPk: c.str("signPk")) }, c.str("expect"), c.str("name"))
        }
        let dir = try firstDirectory()
        for c in v["sealed"]!.items {
            let name = c.str("name")
            let me = c.str("recipient")
            let run = { try Envelopes.open(SealedItem(json: c["item"]!), me: me, keys: self.boxKeys(me), directory: dir) }
            let expect = c["expect"]!
            if let error = expect.opt("error") {
                XCTAssertEqual(code { _ = try run() }, error.string!, name)
                continue
            }
            let opened = try run()
            XCTAssertEqual(opened.signer.id, expect.str("signer"), name)
            // What the schema keeps, written back, is the body the vectors expect.
            XCTAssertEqual(opened.body.json, expect["body"]!, name)
        }
    }

    func testPairing() throws {
        let v = try vectors("pairing.json")
        let pcode = try PairingCode.parse(v.str("code"))
        XCTAssertEqual(pcode.rendezvous, v.str("rendezvous"))
        XCTAssertEqual(pcode.secret, v.str("secret"))
        XCTAssertEqual(toB64(Pairings.key(pcode).bytes), v.str("key"))
        XCTAssertEqual(Pairings.claimHash(v["claim"]!.str("secret")), v["claim"]!.str("hash"))

        let check = v["check"]!
        let entries = check["entries"]!.items
        let id = check.str("id"), key = check.str("key"), proof = check.str("proof")
        XCTAssertEqual(try Pairings.checkCode(entries, id: id), check.str("expect"))
        // Another add entry gives another code: a stand-in, or the same keys added on a fork.
        XCTAssertNotEqual(try Pairings.checkCode(entries, id: "browser"), check.str("expect"))
        XCTAssertEqual(code { _ = try Pairings.checkCode(Array(entries.prefix(2)), id: id) }, "unknown-member")
        XCTAssertEqual(try Pairings.checkProof(entries, id: id, key: key), proof)
        XCTAssertTrue(Pairings.verifyCheckProof(entries, id: id, key: key, proof: proof))
        XCTAssertFalse(Pairings.verifyCheckProof(entries, id: "browser", key: key, proof: proof))
        XCTAssertFalse(Pairings.verifyCheckProof(entries, id: id, key: String(key.dropFirst()) + "0", proof: proof))
        XCTAssertFalse(Pairings.verifyCheckProof(Array(entries.prefix(2)), id: id, key: key, proof: proof))

        for c in v["parse"]!.items {
            let got = (try? PairingCode.parse(c.str("input")).formatted) ?? code { _ = try PairingCode.parse(c.str("input")) }
            XCTAssertEqual(got, c.str("expect"), c.str("input"))
        }

        let request = v["request"]!
        let opened = try Pairings.openRequest(request["message"]!, code: pcode)
        XCTAssertEqual(opened.json, request["body"]!)
        XCTAssertEqual(try Pairings.openApproval(v["approval"]!["message"]!, code: pcode).json, v["approval"]!["body"]!)
        // HMAC is deterministic: what this client makes is the vectors' message, byte for byte.
        XCTAssertEqual(try Pairings.request(opened, code: pcode).json, request["message"]!)
        let approval = try Pairings.openApproval(v["approval"]!["message"]!, code: pcode)
        XCTAssertEqual(try Pairings.approval(approval, code: pcode).json, v["approval"]!["message"]!)

        for c in v["bad"]!.items {
            let cc = try PairingCode.parse(c.str("code"))
            let got = code {
                if c.str("kind") == "request" { _ = try Pairings.openRequest(c["message"]!, code: cc) } else { _ = try Pairings.openApproval(c["message"]!, code: cc) }
            }
            XCTAssertEqual(got, c.str("expect"), c.str("name"))
        }

        // The session-bind signature: Ed25519 is deterministic, so the bytes match.
        let bind = v["bind"]!
        let message = Pairings.bindMessage(account: bind.str("account"), member: bind.str("member"), nonce: bind.str("nonce"))
        XCTAssertEqual(toB64(message), bind.str("message"))
        XCTAssertEqual(toB64(Sodium.sign(message, secretKey: try signKey(bind.str("member")))), bind.str("sig"))
        let verify = { (member: String, nonce: String, sig: String) in
            Pairings.verifyBind(account: bind.str("account"), member: member, nonce: nonce, sig: sig, signPk: bind.str("signPk"))
        }
        XCTAssertTrue(verify(bind.str("member"), bind.str("nonce"), bind.str("sig")))
        XCTAssertFalse(verify("browser", bind.str("nonce"), bind.str("sig")))
        XCTAssertFalse(verify(bind.str("member"), bind.str("nonce") + "x", bind.str("sig")))
        XCTAssertFalse(verify(bind.str("member"), bind.str("nonce"), "AAAA"))

        let links = v["links"]!.items
        XCTAssertEqual(Pairings.link(server: links[0].str("server"), code: pcode), links[0].str("link"))
        XCTAssertEqual(try PairingCode.fromLink(links[0].str("link")).formatted, links[0].str("expect"))
        for c in links.dropFirst() {
            let got = (try? PairingCode.fromLink(c.str("input")).formatted) ?? code { _ = try PairingCode.fromLink(c.str("input")) }
            XCTAssertEqual(got, c.str("expect"), c.str("input"))
        }
        let keyLinks = v["keyLinks"]!.items
        let made = keyLinks[0]
        XCTAssertEqual(Pairings.appLink(server: made.str("server"), code: pcode, checkKey: made.str("key")), made.str("link"))
        XCTAssertEqual(try PairingCode.fromLink(made.str("link")).formatted, v.str("code"))
        for c in keyLinks {
            let input = c.opt("link")?.string ?? c.str("input")
            XCTAssertEqual(Pairings.checkKey(fromLink: input), c.opt("expect")?.string, input)
        }
    }

    func testJoin() throws {
        let v = try vectors("join.json")
        func pair(_ name: String) throws -> KeyPair {
            KeyPair(publicKey: try fromB64(v[name]!.str("publicKey")), secretKey: SecretKey(try fromB64(v[name]!.str("privateKey"))))
        }
        let seeded = Sodium.boxKeyPair(seed: try fromB64(v["joiner"]!.str("seed")))
        XCTAssertEqual(toB64(seeded.publicKey), v["joiner"]!.str("publicKey"))
        XCTAssertEqual(seeded.secretKey.bytes, try fromB64(v["joiner"]!.str("privateKey")))
        let request = v["request"]!
        let text = request.str("text")
        let body = try JoinRequestBody(json: request["body"]!)
        XCTAssertEqual(try Joins.request(body), text)
        XCTAssertEqual(try Joins.openRequest(text), body)
        XCTAssertEqual(Joins.commitment(joinerKey: try fromB64(v["joiner"]!.str("publicKey")), request: text), v.str("commitment"))

        let a = try Joins.approverKeys(mine: pair("approver"), joinerKey: v["joiner"]!.str("publicKey"), request: text, commitment: v.str("commitment"))
        let j = try Joins.joinerKeys(mine: pair("joiner"), approverKey: v["approver"]!.str("publicKey"), request: text)
        XCTAssertEqual(a.digits, v.str("digits"))
        XCTAssertEqual(j.digits, v.str("digits"))
        XCTAssertEqual(toB64(a.macBytes), v.str("mac"))
        XCTAssertEqual(toB64(j.macBytes), v.str("mac"))
        let approval = v["approval"]!
        XCTAssertEqual(try Joins.approval(JoinApprovalBody(json: approval["body"]!), keys: a).json, approval["message"]!)
        XCTAssertEqual(try Joins.openApproval(approval["message"]!, keys: j, join: body.join).json, approval["body"]!)

        for c in v["bad"]!.items {
            let got = code {
                switch c.str("side") {
                case "approver": _ = try Joins.approverKeys(mine: pair("approver"), joinerKey: c.str("joinerKey"), request: c.str("request"), commitment: c.str("commitment"))
                case "joiner": _ = try Joins.joinerKeys(mine: pair("joiner"), approverKey: c.str("approverKey"), request: c.str("request"))
                default: _ = try Joins.openApproval(c["message"]!, keys: j, join: body.join)
                }
            }
            XCTAssertEqual(got, c.str("expect"), c.str("name"))
        }
    }

    func testContext() throws {
        func spans(_ j: JSON) -> [Span] {
            j.items.map { Span($0.str("text"), code: $0.opt("code") != nil, bold: $0.opt("bold") != nil, href: $0.opt("href")?.string) }
        }
        for c in try vectors("context.json")["cases"]!.items {
            let blocks: [Block] = c["blocks"]!.items.map {
                switch $0.str("kind") {
                case "code": .code($0.str("text"))
                case "bullet": .item(marker: "•", spans: spans($0["spans"]!))
                case "number": .item(marker: $0.str("marker"), spans: spans($0["spans"]!))
                default: .line(spans($0["spans"]!))
                }
            }
            XCTAssertEqual(parseContext(c.str("text")), blocks, c.str("name"))
            XCTAssertEqual(contextText(c.str("text")), c.str("plain"), c.str("name"))
        }
    }

    func testQuotaAlerts() throws {
        let v = try vectors("quota-alerts.json")
        func settings(_ j: JSON) -> QuotaAlertSettings {
            QuotaAlertSettings(
                short: j["short"]!.items.map(\.string!), long: j["long"]!.items.map(\.string!),
                windows: Dictionary(uniqueKeysWithValues: j["windows"]!.object!.map { ($0, $1.items.map(\.string!)) })
            )
        }
        XCTAssertEqual(settings(v["defaults"]!), QuotaAlertSettings.defaults)
        for c in v["cases"]!.items {
            let a = c["alert"]!
            let wants = settings(c["settings"]!).wants(
                provider: a.str("provider"), window: a.str("window"), kind: a.str("kind"),
                threshold: a.opt("threshold").map { Int($0.number!) }, minutes: c.opt("windowMinutes").map { Int($0.number!) }
            )
            XCTAssertEqual(wants, c["expect"]!.bool!, c.str("name"))
        }
        for c in v["migrate"]!.items {
            let old = c["old"]!
            let migrated = QuotaAlertSettings.migrate(
                notify: old["notify"]!.items.map(\.string!), notifyLow: old.opt("notifyLow")?.bool ?? true, notifyPace: old.opt("notifyPace")?.bool ?? true
            )
            XCTAssertEqual(migrated, settings(c["expect"]!), c.str("name"))
        }
    }

    func testSchemas() throws {
        let v = try vectors("schemas.json")
        for kind in ["decision", "answer", "permission", "permission-answer", "settled", "waiting", "snooze", "run", "quota"] {
            for c in v[kind]!.items {
                let name = "\(kind): \(c.str("name"))"
                // As a reader parses it (`parseBody`).
                let body = try? parseStrict(kind, readable(kind, c["body"]!)).item
                XCTAssertEqual(body != nil, c["valid"]!.bool!, name)
                if let read = c["read"] { XCTAssertTrue(reads(read, body?.json), "\(name) reads") }
            }
        }
        // Bodies as JSON text, for what a vector file cannot hold: lone surrogates (#1090).
        for c in v["text"]!.items {
            let body = try? parseBody(c.str("kind"), c.str("text"))
            XCTAssertEqual(body != nil, c["valid"]!.bool!, "\(c.str("kind")) text: \(c.str("name"))")
        }
    }

    /** Whether `actual` holds `expected`: objects by their keys, arrays whole, null as absent. */
    private func reads(_ expected: JSON, _ actual: JSON?) -> Bool {
        switch expected {
        case .null: return actual == nil || actual == .null
        case .array(let e):
            guard let a = actual?.array, a.count == e.count else { return false }
            return zip(e, a).allSatisfy { reads($0, $1) }
        case .object(let e):
            guard let a = actual?.object else { return false }
            return e.allSatisfy { k, v in reads(v, a[k]) }
        default: return expected == actual
        }
    }

    func testImages() throws {
        for c in try vectors("images.json")["cases"]!.items {
            let ref = ImageRef(key: c["ref"]!.str("key"), hash: c["ref"]!.str("hash"))
            XCTAssertEqual(code { _ = try Images.open(c.str("blob"), ref: ref) }, c.str("expect"), c.str("name"))
            if let plain = c.opt("plain") { XCTAssertEqual(toB64(try Images.open(c.str("blob"), ref: ref)), plain.string!, c.str("name")) }
        }
    }

    func testSealedImageOpensWithItsRefAndEachSealDrawsANewKey() throws {
        let bytes: [UInt8] = [1, 2, 3]
        let a = Images.seal(bytes)
        let b = Images.seal(bytes)
        XCTAssertEqual(try Images.open(a.blob, ref: a.ref), bytes)
        XCTAssertNotEqual(a.ref.key, b.ref.key)
        XCTAssertNotEqual(Array(try fromB64(a.blob).prefix(24)), Array(try fromB64(b.blob).prefix(24)), "a fresh nonce per seal")
        XCTAssertEqual(code { _ = try Images.open(a.blob, ref: b.ref) }, "cannot-open")
    }

    func testRecoveryKey() throws {
        let recovery = keys["recovery"]!
        let key = recovery.str("key")
        let seed = SecretKey(try fromB64(recovery.str("seed")))
        XCTAssertEqual(RecoveryKeys.encode(seed), key)
        XCTAssertEqual(toB64(RecoveryKeys.keyPair(seed).publicKey), recovery.str("signPk"))
        for typed in [key] + recovery["typed"]!.items.map({ $0.string! }) {
            XCTAssertEqual(toB64(try RecoveryKeys.seed(typed).bytes), recovery.str("seed"), typed)
        }
        let chars = Array(key)
        XCTAssertEqual(RecoveryKeys.read(String(chars[..<5]) + "U" + String(chars[6...])).problem, .badCharacter(index: 4, char: "U"))
        XCTAssertEqual(RecoveryKeys.read(String(chars[..<5]) + (chars[5] == "2" ? "3" : "2") + String(chars[6...])).problem, .checksum)
        XCTAssertNil(RecoveryKeys.read(String(chars[..<9]), typing: true).problem)
        XCTAssertEqual(RecoveryKeys.read(String(chars[..<9])).problem, .length(count: 8))
        XCTAssertEqual(RecoveryKeys.read("7KQU", typing: true).problem, .badCharacter(index: 3, char: "U"))
        for r in recovery["read"]!.items {
            let reading = RecoveryKeys.read(r.str("typed"), typing: true)
            XCTAssertEqual(reading.count, Int(r["count"]!.number!), r.str("typed"))
            XCTAssertEqual(reading.problem, .badCharacter(index: Int(r["index"]!.number!), char: Character(r.str("char"))), r.str("typed"))
        }
    }

    /** Entries this client writes pass its own verifier, and so the vectors' rules. */
    func testWrittenEntriesVerify() throws {
        func m(_ id: String) throws -> Member { try Member(json: member(id)) }
        let phone = try m("phone"), devbox = try m("devbox")
        let phoneSk = try signKey("phone")
        let recovery = RecoveryKeys.keyPair(SecretKey(try fromB64(keys["recovery"]!.str("seed"))))
        let at = "2026-10-04T10:00:00Z"
        let genesis = Directories.genesisEntry(account: "acct_1", device: phone, signKey: phoneSk, recovery: recovery, at: at)
        var dir = try Directories.verify([genesis.json], account: "acct_1", recoveryPk: toB64(recovery.publicKey))
        let add = Directories.addEntry(dir, signer: phone.id, signKey: phoneSk, member: devbox, at: at)
        dir = try Directories.verify([genesis.json, add.json])
        let revoke = Directories.revokeEntry(dir, signer: phone.id, signKey: phoneSk, id: devbox.id, at: at)
        dir = try Directories.verify([genesis.json, add.json, revoke.json], pin: Pin(length: dir.length, head: dir.head))
        XCTAssertEqual(dir.active(.device).map(\.id), ["phone"])
        XCTAssertEqual(dir.active(.machine), [])

        // A recovery key is proposed by the device and confirmed by the current key.
        let next = Sodium.signKeyPair()
        let propose = Directories.recoveryEntry(dir, signer: phone.id, signKey: phoneSk, recovery: next, at: at)
        let chain = [genesis.json, add.json, revoke.json, propose.json]
        dir = try Directories.verify(chain)
        let confirm = try Directories.recoveryConfirmEntry(dir, recoveryKey: recovery.secretKey, recoveryPk: toB64(next.publicKey), at: at)
        dir = try Directories.verify(chain + [confirm.json])
        XCTAssertEqual(dir.recoveryPk, toB64(next.publicKey))
        // The retired key signs nothing more: a recover under it fails.
        let browser = try m("browser")
        let stale = Directories.recoverEntry(dir, recoveryKey: recovery.secretKey, member: browser, at: at)
        XCTAssertEqual(code { _ = try Directories.verify(chain + [confirm.json, stale.json]) }, "bad-signature")
        let recover = Directories.recoverEntry(dir, recoveryKey: next.secretKey, member: browser, at: at)
        XCTAssertEqual(try Directories.verify(chain + [confirm.json, recover.json]).active(.device).map(\.id), ["browser"])
    }

    /** An answer this client seals opens for the machine that asked, and only names it. */
    func testSealedAnswerOpensForTheMachine() throws {
        let dir = try firstDirectory()
        let body: JSON = ["v": 1, "id": "ans_9", "decisionId": "dec_1", "to": "devbox", "answeredAt": "2026-10-04T10:03:00Z", "choice": "Yes"]
        let machine = dir.members["devbox"]!.member
        let item = try Envelopes.seal(kind: .answer, body: body, signer: "phone", secretKey: signKey("phone"), recipients: [machine])
        XCTAssertEqual(item.re, "dec_1")
        // The item survives the wire: written, parsed back, opened.
        let opened = try Envelopes.open(SealedItem(json: JSON.parse(item.json.text)), me: "devbox", keys: boxKeys("devbox"), directory: dir)
        XCTAssertEqual(opened.signer.id, "phone")
        XCTAssertEqual(opened.bodyText, body.text)
        let browser = dir.members["browser"]!.member
        XCTAssertThrowsError(try Envelopes.seal(kind: .answer, body: body, signer: "phone", secretKey: signKey("phone"), recipients: [machine, browser]))
        // Each box is its own sealed box: an ephemeral key per box, so two seals never repeat.
        let again = try Envelopes.seal(kind: .answer, body: body, signer: "phone", secretKey: signKey("phone"), recipients: [machine])
        XCTAssertNotEqual(item.boxes[0].box, again.boxes[0].box)
    }
}

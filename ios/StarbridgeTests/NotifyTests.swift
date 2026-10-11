import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** An account made here, offline: this iPhone as its first device, and one machine. */
struct NotifyFixture {
    let phone: Member
    let machine: Member
    let machineSign: SecretKey
    let saved: Saved
    let secrets: Secrets

    init() throws {
        let phoneKeys = MemberKeys.generate()
        let machineKeys = MemberKeys.generate()
        phone = Member(id: "d_phone", role: .device, name: "iPhone", boxPk: toB64(phoneKeys.box.publicKey), signPk: toB64(phoneKeys.sign.publicKey))
        machine = Member(id: "m_devbox", role: .machine, name: "devbox", boxPk: toB64(machineKeys.box.publicKey), signPk: toB64(machineKeys.sign.publicKey))
        machineSign = machineKeys.sign.secretKey
        let at = Dates.format(Date())
        let genesis = Directories.genesisEntry(account: "acct", device: phone, signKey: phoneKeys.sign.secretKey, recovery: RecoveryKeys.keyPair(RecoveryKeys.generateSeed()), at: at)
        let dir0 = try Directories.verify([genesis.json], account: "acct")
        let add = Directories.addEntry(dir0, signer: phone.id, signKey: phoneKeys.sign.secretKey, member: machine, at: at)
        let dir = try Directories.verify([genesis.json, add.json], account: "acct")
        var s = Saved(server: "http://localhost:1")
        s.account = "acct"
        s.me = SavedMember(id: phone.id, name: phone.name, boxPk: phone.boxPk, signPk: phone.signPk)
        s.entries = [genesis.json.text, add.json.text]
        s.pin = Pin(length: dir.length, head: dir.head)
        saved = s
        var k = Secrets(session: "sbs_test")
        k.boxPk = phone.boxPk
        k.boxSk = toB64(phoneKeys.box.secretKey.bytes)
        k.signPk = phone.signPk
        k.signSk = toB64(phoneKeys.sign.secretKey.bytes)
        secrets = k
    }

    static let source: JSON = ["machine": "devbox", "project": "starbridge", "session": "s1"]

    func seal(_ kind: ItemKind, _ body: JSONObject, by signer: Member? = nil, key: SecretKey? = nil) throws -> SealedItem {
        try Envelopes.seal(kind: kind, body: .object(body), signer: (signer ?? machine).id, secretKey: key ?? machineSign, recipients: [phone])
    }

    func decision(_ id: String, options: [JSON] = ["Merge", "Wait", "Close", "Ask later"], recommended: String? = "Wait", replies: Bool = false) throws -> SealedItem {
        var body: JSONObject = [
            "v": 1, "id": .string(id), "to": [.string(phone.id)], "createdAt": .string(Dates.format(Date())), "question": "Merge the inbox PR?",
            "context": "**Tests** pass.\nCI is green.", "options": .array(options), "source": Self.source,
        ]
        if let recommended { body["recommended"] = .string(recommended) }
        if replies { body["replies"] = true }
        return try seal(.decision, body)
    }

    /** The push payload `p` as the server sends it to APNs: the item's hints and this iPhone's box. */
    func payload(_ item: SealedItem, box: Bool = true) -> JSON {
        var p: JSONObject = ["v": 1, "kind": .string(item.kind.rawValue), "id": .string(item.id), "from": .string(item.from)]
        if let re = item.re { p["re"] = .string(re) }
        if box { p["box"] = .string(item.boxes[0].box) }
        return .object(p)
    }
}

/** What a notification says once the service extension opens its box (#1137). */
final class NotifyTests: XCTestCase {
    func testAQuestionShowsItsWordsAndItsButtons() async throws {
        let f = try NotifyFixture()
        let item = try f.decision("d_one", replies: true)
        let shown = await Notify.shown(f.payload(item), saved: f.saved, secrets: f.secrets) { _ in nil }
        XCTAssertEqual(shown?.title, "Merge the inbox PR?")
        XCTAssertEqual(shown?.subtitle, "devbox · starbridge")
        XCTAssertEqual(shown?.body, "Tests pass. CI is green.")
        XCTAssertEqual(shown?.category, "d.d_one")
        // Three options, the agent's default first, then Reply.
        XCTAssertEqual(shown?.actions.map(\.title), ["Wait", "Merge", "Close", "Reply"])
        XCTAssertEqual(shown?.actions.first?.id, "o:Wait")
        XCTAssertEqual(shown?.actions.last?.text, true)
    }

    func testAPushWithoutItsBoxFetchesTheItem() async throws {
        let f = try NotifyFixture()
        let item = try f.decision("d_big", options: [], recommended: nil)
        var asked: [String] = []
        let shown = await Notify.shown(f.payload(item, box: false), saved: f.saved, secrets: f.secrets) { id in
            asked.append(id)
            return item
        }
        XCTAssertEqual(asked, ["d_big"])
        XCTAssertEqual(shown?.actions.map(\.title), ["Answer"])
    }

    func testAWaitingFlipShowsItsQuestion() async throws {
        let f = try NotifyFixture()
        let question = try f.decision("d_wait")
        let flip: (String) throws -> SealedItem = { state in
            try f.seal(.waiting, ["v": 1, "id": "w_1", "decisionId": "d_wait", "to": [.string(f.phone.id)], "at": .string(Dates.format(Date())), "state": .string(state)])
        }
        let waiting = await Notify.shown(f.payload(try flip("waiting")), saved: f.saved, secrets: f.secrets) { _ in question }
        XCTAssertEqual(waiting?.body, "Waiting for you · Tests pass. CI is green.")
        XCTAssertEqual(waiting?.quiet, false)
        let working = await Notify.shown(f.payload(try flip("working")), saved: f.saved, secrets: f.secrets) { _ in question }
        XCTAssertEqual(working?.quiet, true)
    }

    func testAPromptOpensTheAppToAllow() async throws {
        let f = try NotifyFixture()
        let at = Date()
        let item = try f.seal(.permission, [
            "v": 1, "id": "p_one", "to": [.string(f.phone.id)], "createdAt": .string(Dates.format(at)), "agent": "claude-code", "tool": "Bash",
            "summary": "bun test", "description": "Run the server tests", "input": "{\"command\":\"bun test\"}", "inputHash": .string(toB64(Sodium.randomBytes(32))),
            "suggestions": [], "expiresAt": .string(Dates.format(at.addingTimeInterval(300))), "source": NotifyFixture.source,
        ])
        let shown = await Notify.shown(f.payload(item), saved: f.saved, secrets: f.secrets) { _ in nil }
        XCTAssertEqual(shown?.title, "Run the server tests")
        XCTAssertEqual(shown?.body, "bun test")
        XCTAssertEqual(shown?.category, "permission")
        XCTAssertEqual(Notify.permissionActions.map(\.id), ["allow", "deny"])
        XCTAssertEqual(Notify.permissionActions.first?.foreground, true)
    }

    /** The placeholder stays for anything this iPhone cannot vouch for. */
    func testAStrangersItemKeepsThePlaceholder() async throws {
        let f = try NotifyFixture()
        let strangerKeys = MemberKeys.generate()
        let stranger = Member(id: "m_other", role: .machine, name: "other", boxPk: toB64(strangerKeys.box.publicKey), signPk: toB64(strangerKeys.sign.publicKey))
        let item = try f.seal(.decision, [
            "v": 1, "id": "d_x", "to": [.string(f.phone.id)], "createdAt": .string(Dates.format(Date())), "question": "Q?",
            "context": "", "options": [], "source": NotifyFixture.source,
        ], by: stranger, key: strangerKeys.sign.secretKey)
        let shown = await Notify.shown(f.payload(item), saved: f.saved, secrets: f.secrets) { _ in nil }
        XCTAssertNil(shown)
        var noKeys = f.secrets
        noKeys.boxSk = nil
        let unopened = await Notify.shown(f.payload(try f.decision("d_y")), saved: f.saved, secrets: noKeys) { _ in nil }
        XCTAssertNil(unopened)
    }

    /** Push services keep no order: a snooze's first push after its return leaves the question up (#1320). */
    func testASnoozesFirstPushAfterItsTimeLeavesItsNotification() throws {
        let now = Date()
        func snooze(due: Bool?, wakeAt: Date) throws -> JSON {
            var p: JSONObject = ["v": 1, "kind": "snooze", "id": "z_1", "from": "d_phone", "re": "d_1", "wakeAt": .string(Dates.format(wakeAt))]
            if let due { p["due"] = .bool(due) }
            return .object(p)
        }
        XCTAssertTrue(Notify.closes(try snooze(due: false, wakeAt: now.addingTimeInterval(300)), now: now))
        XCTAssertFalse(Notify.closes(try snooze(due: false, wakeAt: now.addingTimeInterval(-60)), now: now))
        // Its return may already show, by a server clock a minute ahead.
        XCTAssertFalse(Notify.closes(try snooze(due: false, wakeAt: now.addingTimeInterval(60)), now: now))
        // A server before #1290 sends no `due`: every snooze closes, as before.
        XCTAssertTrue(Notify.closes(try snooze(due: nil, wakeAt: now.addingTimeInterval(-60)), now: now))
        XCTAssertTrue(Notify.closes(.object(["v": 1, "kind": "answered", "id": "d_1"]), now: now))
        XCTAssertFalse(Notify.closes(.object(["v": 1, "kind": "quota", "id": "q_1"]), now: now))
    }
}

import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** Keeps the secrets in memory. */
final class MemoryVault: Vault, @unchecked Sendable {
    var secrets = Secrets()
    func load() throws -> Secrets { secrets }
    func save(_ secrets: Secrets) throws { self.secrets = secrets }
    var aside: [String: Secrets] = [:]
    var asideFails = false
    func setAside(_ tag: String) throws {
        if asideFails { throw Notice(message: "keychain: locked") }
        aside[tag] = secrets
        secrets = Secrets()
    }
}

/**
 * The app joins an account on a real self-hosted server, by digits and then by a scanned QR
 * code, while this test plays the device that approves it. It runs when the test process has
 * STARBRIDGE_TEST_SERVER and STARBRIDGE_TEST_OWNER_TOKEN, for a server whose account has no
 * device yet (README.md, "Test").
 */
@MainActor
final class JoinTests: XCTestCase {
    private var server = ""
    private var token = ""

    override func setUp() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let s = env["STARBRIDGE_TEST_SERVER"], let t = env["STARBRIDGE_TEST_OWNER_TOKEN"] else {
            throw XCTSkip("no STARBRIDGE_TEST_SERVER")
        }
        server = s
        token = t
    }

    /** A raw call as the approving device. */
    @discardableResult
    private func call(_ session: String, _ method: String, _ path: String, _ body: JSON? = nil) async throws -> JSON? {
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/v1" + path)))
        request.httpMethod = method
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.text.utf8)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue((200..<300).contains(status), "\(method) \(path): \(status) \(text)")
        return data.isEmpty ? nil : try JSON.parse(text)
    }

    private func until(_ what: String, _ done: () -> Bool) async throws {
        for _ in 0..<150 {
            if done() { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func now() -> String { ISO8601DateFormatter().string(from: Date()) }

    func testJoinsByDigitsThenByCode() async throws {
        // The account's first device, made here: the one that approves.
        let api = Api(server: server, session: nil)
        let session = try await api.ownerSession(token: token)
        let account = try await Api(server: server, session: session).me().account
        let entries0 = try await Api(server: server, session: session).directory(from: 0)
        try XCTSkipUnless(entries0.isEmpty, "the server's account already has devices")
        // The tests after this one need an empty account; the approver's session deletes it.
        addTeardownBlock { [server] in
            var request = URLRequest(url: URL(string: server + "/v1/account")!)
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: request)
        }
        let keys = MemberKeys.generate()
        let first = Member(id: "d_first", role: .device, name: "Approver", boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey))
        let recovery = RecoveryKeys.keyPair(RecoveryKeys.generateSeed())
        let genesis = Directories.genesisEntry(account: account, device: first, signKey: keys.sign.secretKey, recovery: recovery, at: now())
        try await call(session, "POST", "/directory", ["entry": genesis.json])
        func directory() async throws -> Directory {
            try Directories.verify(try await Api(server: server, session: session).directory(from: 0), account: account)
        }

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let vault = MemoryVault()
        let store = Store(vault: vault, disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")

        // --- By digits ---
        await store.signInWaiting(server: server, token: token)
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.phase, .noDevice(accountExists: true))
        await store.askDevices()
        XCTAssertNil(store.notice)
        let list = try await call(session, "GET", "/joins?after=0&wait=0")
        let join = try XCTUnwrap(list?["joins"]?.array?.first)
        let id = try XCTUnwrap(join["id"]?.string)
        let request = try XCTUnwrap(join["request"]?.string)
        let commitment = try XCTUnwrap(join["commitment"]?.string)
        let mine = Joins.newKeyPair()
        try await call(session, "POST", "/joins/\(id)/approver", ["key": .string(toB64(mine.publicKey)), "approver": .string(first.id)])
        var joinerKey: String?
        for _ in 0..<50 where joinerKey == nil {
            joinerKey = try await call(session, "GET", "/joins/\(id)?after=0&wait=0")?["join"]?["joinerKey"]?.string
            if joinerKey == nil { try await Task.sleep(for: .milliseconds(200)) }
        }
        let joinKeys = try Joins.approverKeys(mine: mine, joinerKey: try XCTUnwrap(joinerKey), request: request, commitment: commitment)
        try await until("the digits") { store.phase == .joiningByDigits(digits: joinKeys.digits, matched: false) }

        let asked = try Joins.openRequest(request)
        let joiner = Member(id: asked.id, role: .device, name: asked.name, boxPk: asked.boxPk, signPk: asked.signPk)
        XCTAssertEqual(joiner.name, "Test iPhone")
        try await call(session, "POST", "/directory", ["entry": Directories.addEntry(try await directory(), signer: first.id, signKey: keys.sign.secretKey, member: joiner, at: now()).json])
        let added = try await directory()
        let approval = try Joins.approval(JoinApprovalBody(join: id, account: account, length: added.length, head: added.head, approver: first.id), keys: joinKeys)
        try await call(session, "POST", "/joins/\(id)/approve", ["approval": approval.json])
        // The approval waits for the owner to see the digits match.
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(store.phase, .joiningByDigits(digits: joinKeys.digits, matched: false))
        store.confirmDigits()
        try await until("joined by digits") { store.phase == .ready }
        XCTAssertEqual(store.me?.id, joiner.id)
        let bound = try await Api(server: server, session: vault.secrets.session).me().member
        XCTAssertEqual(bound, joiner.id)

        // Signing out removes this iPhone from the devices, since the approver stays.
        await store.signOut()
        XCTAssertEqual(store.phase, .signedOut)
        XCTAssertEqual(vault.secrets, Secrets())
        let left = try await directory()
        XCTAssertEqual(left.members[joiner.id]?.active, false)

        // --- By a scanned QR code ---
        await store.signInWaiting(server: server, token: token)
        let code = PairingCode.generate()
        await store.joinWithCode(Pairings.link(server: server, code: code))
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.phase, .joining)
        let pending = try await call(session, "GET", "/pairings/\(code.rendezvous)?wait=10")
        let posted = try XCTUnwrap(pending?["request"])
        let body = try Pairings.openRequest(posted, code: code)
        let phone = Member(id: body.id, role: .device, name: body.name, boxPk: body.boxPk, signPk: body.signPk)
        try await call(session, "POST", "/directory", ["entry": Directories.addEntry(try await directory(), signer: first.id, signKey: keys.sign.secretKey, member: phone, at: now()).json])
        let withPhone = try await directory()
        let pairingApproval = try Pairings.approval(PairingApprovalBody(rendezvous: code.rendezvous, account: account, length: withPhone.length, head: withPhone.head, approver: first.id), code: code)
        try await call(session, "POST", "/pairings/\(code.rendezvous)/approve", ["approval": pairingApproval.json])
        try await until("joined by code") { store.phase == .ready }
        XCTAssertEqual(store.me?.id, phone.id)
        XCTAssertEqual(store.saved.pin, Pin(length: withPhone.length, head: withPhone.head))
    }
}

import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** A server whose directory serves `entries`, from the index the iPhone asks for; every other read fails. */
final class ChainServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var entries: [JSON] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var status = 500
        var body = #"{"error":"internal"}"#
        if let url = request.url, url.path().hasSuffix("/v1/directory") {
            let from = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "from" }?.value.flatMap(Int.init) ?? 0
            status = 200
            body = JSON.object(["entries": .array(Array(ChainServer.entries.dropFirst(from)))]).text
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/**
 * A chain that revokes this iPhone while a machine's kept head shows it cut short holds rather
 * than wipes (#1779): the server, with a revoked device whose revocation it hides, could fork it.
 */
@MainActor
final class RemovalHoldTests: XCTestCase {
    func testAForkThatRevokesThisIPhoneHoldsAndARevocationTheHeadsAgreeWithWipes() async throws {
        let at = Dates.format(Date())
        let phoneKeys = MemberKeys.generate()
        let thiefKeys = MemberKeys.generate()
        let tabletKeys = MemberKeys.generate()
        let machineKeys = MemberKeys.generate()
        func member(_ id: String, _ role: Role, _ name: String, _ keys: MemberKeys) -> Member {
            Member(id: id, role: role, name: name, boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey))
        }
        let phone = member("d_phone", .device, "iPhone", phoneKeys)
        let thief = member("d_thief", .device, "Stolen phone", thiefKeys)
        let tablet = member("d_tablet", .device, "Tablet", tabletKeys)
        let machine = member("m_devbox", .machine, "devbox", machineKeys)
        var entries = [Directories.genesisEntry(account: "acct", device: phone, signKey: phoneKeys.sign.secretKey, recovery: RecoveryKeys.keyPair(RecoveryKeys.generateSeed()), at: at).json]
        for m in [thief, tablet, machine] {
            entries.append(Directories.addEntry(try Directories.verify(entries, account: "acct"), signer: phone.id, signKey: phoneKeys.sign.secretKey, member: m, at: at).json)
        }
        let known = try Directories.verify(entries, account: "acct")
        // The tablet revokes the stolen phone; the machine sees it, and the server hides it from this iPhone.
        let truth = entries + [Directories.revokeEntry(known, signer: tablet.id, signKey: tabletKeys.sign.secretKey, id: thief.id, at: at).json]
        let truthDir = try Directories.verify(truth, account: "acct")
        // On the stale chain, the stolen phone revokes this iPhone.
        let fork = entries + [Directories.revokeEntry(known, signer: thief.id, signKey: thiefKeys.sign.secretKey, id: phone.id, at: at).json]

        var saved = Saved(server: "http://localhost:1")
        saved.account = "acct"
        saved.me = SavedMember(id: phone.id, name: phone.name, boxPk: phone.boxPk, signPk: phone.signPk)
        saved.entries = entries.map(\.text)
        saved.pin = Pin(length: known.length, head: known.head)
        let head: JSON = ["length": .number(Double(truthDir.length)), "head": .string(truthDir.head)]
        saved.heads = [SavedHead(id: machine.id, head: head.text)]
        var secrets = Secrets(session: "sbs_test")
        secrets.boxPk = phone.boxPk
        secrets.boxSk = toB64(phoneKeys.box.secretKey.bytes)
        secrets.signPk = phone.signPk
        secrets.signSk = toB64(phoneKeys.sign.secretKey.bytes)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let vault = MemoryVault()
        vault.secrets = secrets
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChainServer.self]
        let store = Store(vault: vault, disk: disk, deviceName: "Test iPhone", http: URLSession(configuration: config))

        ChainServer.entries = fork
        try await store.serial { try await store.syncDirectory() }
        XCTAssertEqual(store.phase, .ready)
        XCTAssertNotNil(vault.secrets.signSk)
        XCTAssertEqual(store.saved.entries.count, entries.count)
        XCTAssertTrue(store.withheldWhy?.contains("says this iPhone was removed, but devbox has seen") == true)
        XCTAssertNil(store.heldRevoked)

        // The tablet revokes this iPhone on the real chain, which the head does not contradict: it wipes.
        ChainServer.entries = truth + [Directories.revokeEntry(truthDir, signer: tablet.id, signKey: tabletKeys.sign.secretKey, id: phone.id, at: at).json]
        try await store.serial { try await store.syncDirectory() }
        XCTAssertNotEqual(store.phase, .ready)
        XCTAssertNil(vault.secrets.signSk)
        XCTAssertEqual(store.notice, "This iPhone was removed from your devices.")
    }
}

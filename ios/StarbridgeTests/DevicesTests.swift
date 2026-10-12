import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * Devices on a real self-hosted server: the iPhone sets up the account, a machine this test
 * plays pairs, and the list shows both, with the machine's check code and what the server says
 * of them; revoking the machine takes it off the list and ends its token. The account is deleted
 * afterwards (README.md, "Build and test").
 */
@MainActor
final class DevicesTests: XCTestCase {
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

    private func call(_ auth: String?, _ method: String, _ path: String, _ body: JSON? = nil, headers: [String: String] = [:]) async throws -> (Int, JSON?) {
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/v1" + path)))
        request.httpMethod = method
        if let auth { request.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.text.utf8)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let text = String(decoding: data, as: UTF8.self)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data.isEmpty ? nil : try? JSON.parse(text))
    }

    private func now() -> String { Dates.format(Date()) }

    func testListsAndRevokes() async throws {
        let session = try await Api(server: server, session: nil).ownerSession(token: token)
        let empty = try await Api(server: server, session: session).directory(from: 0).isEmpty
        try XCTSkipUnless(empty, "the server's account already has devices")
        addTeardownBlock { [server, token] in
            let s = try? await Api(server: server, session: nil).ownerSession(token: token)
            var request = URLRequest(url: URL(string: server + "/v1/account")!)
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(s ?? "")", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: request)
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let vault = MemoryVault()
        let store = Store(vault: vault, disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        await store.signInWaiting(server: server, token: token)
        await store.setUpFirstDevice()
        await store.confirmRecoveryKey()
        XCTAssertEqual(store.phase, .ready)
        let phone = try XCTUnwrap(store.me).member
        let phoneSession = try XCTUnwrap(vault.secrets.session)
        let phoneSign = SecretKey(try fromB64(try XCTUnwrap(vault.secrets.signSk)))
        let account = try XCTUnwrap(store.saved.account)
        try await store.api().notificationState("on")

        // A machine pairs, approved with the iPhone's keys behind the app's back, and says it is behind.
        let keys = MemberKeys.generate()
        let machine = Member(id: "m_devbox", role: .machine, name: "devbox", boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey))
        let code = PairingCode.generate()
        let claim = Pairings.newClaimSecret()
        let request = try Pairings.request(PairingRequestBody(rendezvous: code.rendezvous, role: .machine, id: machine.id, name: machine.name, boxPk: machine.boxPk, signPk: machine.signPk, at: now()), code: code)
        _ = try await call(nil, "POST", "/pairings", ["request": request.json, "claimHash": .string(Pairings.claimHash(claim))])
        let before = try Directories.verify(try await store.api().directory(from: 0), account: account)
        _ = try await call(phoneSession, "POST", "/directory", ["entry": Directories.addEntry(before, signer: phone.id, signKey: phoneSign, member: machine, at: now()).json])
        let added = try Directories.verify(try await store.api().directory(from: 0), account: account)
        let approval = try Pairings.approval(PairingApprovalBody(rendezvous: code.rendezvous, account: account, length: added.length, head: added.head, approver: phone.id), code: code)
        _ = try await call(phoneSession, "POST", "/pairings/\(code.rendezvous)/approve", ["approval": approval.json])
        let result = try await call(nil, "GET", "/pairings/\(code.rendezvous)/result", headers: ["X-Claim": claim])
        let machineToken = try XCTUnwrap(result.1?["token"]?.string)
        let (released, _) = try await call(machineToken, "PUT", "/release", ["version": "0.1.0", "latest": "0.2.0"])
        XCTAssertEqual(released, 204)

        // Devices lists the iPhone first, then the machine with its check code, and what the server says.
        await store.refreshDirectory()
        await store.loadDeviceInfo()
        XCTAssertEqual(store.devices.map(\.id), [phone.id, machine.id])
        XCTAssertTrue(store.devices[0].current)
        let row = store.devices[1]
        XCTAssertTrue(row.machine)
        XCTAssertEqual(row.check, try Pairings.checkCode(store.saved.entries.map(JSON.parse), id: machine.id))
        XCTAssertLessThan(abs(row.addedAt.timeIntervalSinceNow), 120)
        XCTAssertEqual(store.deviceInfo.notify[phone.id], "on")
        XCTAssertEqual(store.deviceInfo.clients[phone.id], "ios")
        XCTAssertEqual(store.deviceInfo.behind, [machine.id])
        XCTAssertEqual(memberSymbol(row, client: nil), "server.rack")

        // Revoking the machine takes it off the list, and the server ends its token.
        await store.revoke(machine.id)
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.devices.map(\.id), [phone.id])
        let (status, _) = try await call(machineToken, "GET", "/answers?wait=0")
        XCTAssertEqual(status, 401)

        // This iPhone is not revoked from its own list.
        await store.revoke(phone.id)
        XCTAssertEqual(store.notice, "Sign out to remove this iPhone.")
    }
}

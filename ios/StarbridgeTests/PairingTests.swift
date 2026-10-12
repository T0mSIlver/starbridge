import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * Adding members from the iPhone on a real self-hosted server: a machine's QR code, whose check
 * key lets the machine save the pairing without asking (#795); a typed code, which carries no
 * proof; a QR code this iPhone shows for a new phone; and codes that fail. The account is deleted
 * afterwards (README.md, "Build and test").
 */
@MainActor
final class PairingTests: XCTestCase {
    private var server = ""
    private var token = ""

    func testOtherServer() {
        let here = "https://starbridge.run"
        XCTAssertNil(otherServer("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", server: here))
        XCTAssertNil(otherServer("https://starbridge.run/pair#ABCD", server: here))
        XCTAssertNil(otherServer("https://STARBRIDGE.run:443/pair#ABCD", server: here))
        XCTAssertEqual(otherServer("https://sb.example.com/pair#ABCD", server: here), "sb.example.com")
        XCTAssertEqual(otherServer("starbridge-pair?server=https%3A%2F%2Fsb.example.com%3A8443&k=K#ABCD", server: here), "sb.example.com:8443")
        XCTAssertEqual(otherServer("starbridge://pair?server=http%3A%2F%2Flocalhost%3A18731#ABCD", server: here), "localhost:18731")
        XCTAssertNil(otherServer("starbridge-pair?server=https%3A%2F%2Fstarbridge.run&k=K#ABCD", server: here))
    }

    private func setUpServer() throws {
        let env = ProcessInfo.processInfo.environment
        guard let s = env["STARBRIDGE_TEST_SERVER"], let t = env["STARBRIDGE_TEST_OWNER_TOKEN"] else {
            throw XCTSkip("no STARBRIDGE_TEST_SERVER")
        }
        server = s
        token = t
    }

    private func call(_ method: String, _ path: String, _ body: JSON? = nil, headers: [String: String] = [:]) async throws -> (Int, JSON?) {
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/v1" + path)))
        request.httpMethod = method
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.text.utf8)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data.isEmpty ? nil : try? JSON.parse(String(decoding: data, as: UTF8.self)))
    }

    /** A new member that posts its request under `code`, as `starbridge pair` or a joining phone does. */
    private struct Newcomer {
        let member: Member
        let claim: String
        let code: PairingCode
    }

    private func request(_ role: Role, _ name: String, code: PairingCode) async throws -> Newcomer {
        let keys = MemberKeys.generate()
        let member = Member(id: (role == .machine ? "m_" : "d_") + name, role: role, name: name, boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey))
        let claim = Pairings.newClaimSecret()
        let body = PairingRequestBody(rendezvous: code.rendezvous, role: role, id: member.id, name: name, boxPk: member.boxPk, signPk: member.signPk, at: Dates.format(Date()))
        let (status, _) = try await call("POST", "/pairings", ["request": try Pairings.request(body, code: code).json, "claimHash": .string(Pairings.claimHash(claim))])
        XCTAssertTrue((200..<300).contains(status))
        return Newcomer(member: member, claim: claim, code: code)
    }

    /** The approval the new member reads once approved, checked as it checks it. */
    private func result(_ n: Newcomer, session: String? = nil) async throws -> PairingApprovalBody {
        // A new device fetches its result signed in to the account.
        var headers = ["X-Claim": n.claim]
        if let session { headers["Authorization"] = "Bearer \(session)" }
        let (status, body) = try await call("GET", "/pairings/\(n.code.rendezvous)/result?wait=5", headers: headers)
        XCTAssertEqual(status, 200)
        let approval = try Pairings.openApproval(try XCTUnwrap(body?["approval"]), code: n.code)
        return approval
    }

    func testAddsMembers() async throws {
        try setUpServer()
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
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        await store.signInWaiting(server: server, token: token)
        await store.setUpFirstDevice()
        await store.confirmRecoveryKey()
        XCTAssertEqual(store.phase, .ready)
        let account = try XCTUnwrap(store.saved.account)
        func chain() async throws -> [JSON] { try await store.api().directory(from: 0) }

        // --- A machine's QR code: the approval proves which entry this iPhone wrote ---
        let key = Pairings.newCheckKey()
        let devbox = try await request(.machine, "devbox", code: PairingCode.generate())
        let qr = "starbridge-pair?server=\(server.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&k=\(key)#\(devbox.code.formatted)"
        await store.lookUpPairing(qr)
        XCTAssertEqual(store.approval, .found(Joiner(name: "devbox", machine: true, code: devbox.code.formatted)))
        await store.approvePairing()
        XCTAssertEqual(store.approval, .done("devbox"))
        let approved = try await result(devbox)
        XCTAssertEqual(approved.account, account)
        let entries = try await chain()
        let verified = try Directories.verify(entries, account: account, pin: approved.pin)
        try Pairings.checkJoined(verified, id: devbox.member.id, role: .machine, boxPk: devbox.member.boxPk, signPk: devbox.member.signPk)
        XCTAssertTrue(Pairings.verifyCheckProof(entries, id: devbox.member.id, key: key, proof: try XCTUnwrap(approved.check)))
        XCTAssertEqual(store.devices.map(\.name), ["Test iPhone", "devbox"])

        // --- A typed code carries no proof: the machine asks its owner to compare codes ---
        let laptop = try await request(.machine, "laptop", code: PairingCode.generate())
        await store.lookUpPairing(laptop.code.formatted.lowercased())
        XCTAssertEqual(store.approval, .found(Joiner(name: "laptop", machine: true, code: laptop.code.formatted)))
        await store.approvePairing()
        XCTAssertEqual(store.approval, .done("laptop"))
        let typed = try await result(laptop)
        XCTAssertNil(typed.check)

        // --- This iPhone shows a QR code; a new phone scans it and posts under it ---
        store.showCode()
        guard case let .showing(shown, link) = store.approval else { return XCTFail("no QR code: \(store.approval)") }
        XCTAssertEqual(link, Pairings.link(server: server, code: try PairingCode.parse(shown)))
        let phone = try await request(.device, "pixel", code: try PairingCode.fromLink(link))
        for _ in 0..<50 where store.approval != .found(Joiner(name: "pixel", machine: false, code: shown)) {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(store.approval, .found(Joiner(name: "pixel", machine: false, code: shown)))
        await store.approvePairing()
        XCTAssertEqual(store.approval, .done("pixel"))
        let pixelSession = try await Api(server: server, session: nil).ownerSession(token: token)
        let scanned = try await result(phone, session: pixelSession)
        XCTAssertNil(scanned.check)
        XCTAssertEqual(store.devices.map(\.name), ["Test iPhone", "pixel", "devbox", "laptop"])

        // --- Codes that fail say why, and approve nothing ---
        await store.lookUpPairing("ABCD")
        XCTAssertEqual(store.approval, .failed("A pairing code has 24 letters and digits."))
        await store.lookUpPairing(PairingCode.generate().formatted)
        XCTAssertEqual(store.approval, .failed("No pairing with this code, or it expired."))
        await store.lookUpPairing("https://starbridge.example/pair#" + PairingCode.generate().formatted)
        XCTAssertEqual(store.approval, .failed("This code is from starbridge.example, and this iPhone is signed in to localhost."))
        // A request whose MAC another code made does not show.
        let forged = try await request(.machine, "stand-in", code: PairingCode.generate())
        let wrong = String(forged.code.rendezvous + PairingCode.generate().secret)
        await store.lookUpPairing(wrong)
        XCTAssertEqual(store.approval, .failed("This request does not match the code. Don't approve it; make a new code."))
        await store.approvePairing()
        XCTAssertEqual(store.devices.count, 4)
        store.closePairing()
        XCTAssertEqual(store.approval, .idle)
    }
}

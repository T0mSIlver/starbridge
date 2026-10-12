import StarbridgeProtocol
import UserNotifications
import XCTest
@testable import Starbridge

/** Fails every POST /items with "not connected" while `offline`; the rest goes to the network. */
final class Offline: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var offline = false

    override class func canInit(with request: URLRequest) -> Bool {
        request.httpMethod == "POST" && request.url?.path().hasSuffix("/v1/items") == true && offline
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }

    override func stopLoading() {}
}

/**
 * The iPhone app as the account's first device, with a machine this test plays on a real
 * self-hosted server: the machine asks a question, a permission prompt and a run; the app lists
 * them and answers, once online, once through the outbox (#329), and once from a notification.
 * The account is deleted afterwards, so the other tests find it empty (README.md, "Test").
 */
@MainActor
final class InboxTests: XCTestCase {
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

    @discardableResult
    private func call(_ auth: String?, _ method: String, _ path: String, _ body: JSON? = nil, headers: [String: String] = [:]) async throws -> JSON? {
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/v1" + path)))
        request.httpMethod = method
        if let auth { request.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
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

    private func now(_ offset: TimeInterval = 0) -> String { Dates.format(Date().addingTimeInterval(offset)) }

    func testListsAndAnswers() async throws {
        let session = try await Api(server: server, session: nil).ownerSession(token: token)
        let before = try await Api(server: server, session: session).directory(from: 0)
        try XCTSkipUnless(before.isEmpty, "the server's account already has devices")
        addTeardownBlock { [server, token] in
            let s = try? await Api(server: server, session: nil).ownerSession(token: token)
            var request = URLRequest(url: URL(string: server + "/v1/account")!)
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(s ?? "")", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: request)
        }

        // --- The iPhone sets up the account ---
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Offline.self]
        let vault = MemoryVault()
        let store = Store(vault: vault, disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone", http: URLSession(configuration: config))
        await store.signInWaiting(server: server, token: token)
        await store.setUpFirstDevice()
        await store.confirmRecoveryKey()
        XCTAssertEqual(store.phase, .ready)
        let phone = try XCTUnwrap(store.me).member
        let phoneSession = try XCTUnwrap(vault.secrets.session)
        let phoneSign = SecretKey(try fromB64(try XCTUnwrap(vault.secrets.signSk)))
        let account = try XCTUnwrap(store.saved.account)

        // --- A machine pairs, approved with the iPhone's keys ---
        let keys = MemberKeys.generate()
        let machine = Member(id: "m_devbox", role: .machine, name: "devbox", boxPk: toB64(keys.box.publicKey), signPk: toB64(keys.sign.publicKey))
        let code = PairingCode.generate()
        let claim = Pairings.newClaimSecret()
        let request = try Pairings.request(PairingRequestBody(rendezvous: code.rendezvous, role: .machine, id: machine.id, name: machine.name, boxPk: machine.boxPk, signPk: machine.signPk, at: now()), code: code)
        try await call(nil, "POST", "/pairings", ["request": request.json, "claimHash": .string(Pairings.claimHash(claim))])
        func directory() async throws -> Directory {
            try Directories.verify(try await Api(server: server, session: phoneSession).directory(from: 0), account: account)
        }
        try await call(phoneSession, "POST", "/directory", ["entry": Directories.addEntry(try await directory(), signer: phone.id, signKey: phoneSign, member: machine, at: now()).json])
        let added = try await directory()
        let approval = try Pairings.approval(PairingApprovalBody(rendezvous: code.rendezvous, account: account, length: added.length, head: added.head, approver: phone.id), code: code)
        try await call(phoneSession, "POST", "/pairings/\(code.rendezvous)/approve", ["approval": approval.json])
        let result = try await call(nil, "GET", "/pairings/\(code.rendezvous)/result", headers: ["X-Claim": claim])
        let machineToken = try XCTUnwrap(result?["token"]?.string)

        func post(_ kind: ItemKind, _ body: JSONObject) async throws {
            let item = try Envelopes.seal(kind: kind, body: .object(body), signer: machine.id, secretKey: keys.sign.secretKey, recipients: [phone])
            try await call(machineToken, "POST", "/items", item.json)
        }
        let source: JSON = ["machine": "devbox", "project": "starbridge", "session": "s1"]
        func ask(_ id: String) async throws {
            try await post(.decision, [
                "v": 1, "id": .string(id), "to": [.string(phone.id)], "createdAt": .string(now()), "question": "Ship it?",
                "context": "**Tests** pass.", "options": ["Yes", "No"], "recommended": "Yes", "source": source,
            ])
        }
        /** The answers the machine has, opened with its keys. */
        func answers() async throws -> [Answer] {
            let list = try await call(machineToken, "GET", "/answers?wait=0")
            let dir = try await directory()
            return try (list?["items"]?.array ?? []).compactMap { json in
                let item = try SealedItem(json: json["item"] ?? json)
                return try Envelopes.open(item, me: machine.id, keys: keys.box, directory: dir).body as? Answer
            }
        }

        try await ask("d_one")
        try await post(.waiting, ["v": 1, "id": "w_one", "decisionId": "d_one", "to": [.string(phone.id)], "at": .string(now()), "state": "waiting"])
        try await post(.permission, [
            "v": 1, "id": "p_one", "to": [.string(phone.id)], "createdAt": .string(now()), "agent": "claude-code", "tool": "Bash",
            "summary": "Run the tests", "input": "{\"command\":\"bun test\"}", "inputHash": .string(toB64(Sodium.randomBytes(32))),
            "suggestions": [], "expiresAt": .string(now(300)), "source": source,
        ])
        try await post(.run, [
            "v": 1, "id": "r_one", "to": [.string(phone.id)], "title": "Release build", "reason": "Blocks the owner",
            "source": source, "startedAt": .string(now(-60)), "at": .string(now()),
        ])

        // --- The iPhone lists them ---
        await store.refresh()
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.openDecisions.map(\.id), ["d_one"])
        XCTAssertEqual(store.openDecisions.first?.waiting, "waiting")
        XCTAssertEqual(store.openPrompts.map(\.id), ["p_one"])
        XCTAssertEqual(store.shownRuns.map(\.id), ["r_one"])

        // Notifications, as APNs would have shown them: a sync closes those of items it finds closed (#1184).
        _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.provisional, .alert])
        func delivered() async -> Set<String> { Set(await UNUserNotificationCenter.current().deliveredNotifications().map(\.request.identifier)) }
        func show(_ id: String) async throws {
            await Notify.post(id, kind: "decision", title: "Ship it?", subtitle: nil, body: "")
            for _ in 0..<50 where await !delivered().contains(id) { try await Task.sleep(for: .milliseconds(100)) }
            let shown = await delivered()
            XCTAssertTrue(shown.contains(id))
        }
        try await show("d_one")

        // --- Answered online: it leaves at the tap, and the machine gets it ---
        store.answer("d_one", choice: "Yes", text: nil)
        XCTAssertTrue(store.openDecisions.isEmpty)
        for _ in 0..<50 where store.decision("d_one")?.answer == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(store.decision("d_one")?.answer, "Yes")
        var got = try await answers()
        XCTAssertEqual(got.map(\.decisionId), ["d_one"])
        XCTAssertEqual(got.first?.choice, "Yes")
        await store.refresh()
        var shown = await delivered()
        XCTAssertFalse(shown.contains("d_one"))

        await store.answerPrompt("p_one", allow: true)
        XCTAssertNil(store.notice)
        XCTAssertTrue(store.openPrompts.isEmpty)

        // --- Answered offline: kept in the outbox, sent once the server can be reached ---
        try await ask("d_two")
        await store.refresh()
        XCTAssertEqual(store.openDecisions.map(\.id), ["d_two"])
        Offline.offline = true
        defer { Offline.offline = false }
        store.drafts["d_two"] = "Not yet"
        store.answer("d_two", choice: nil, text: "Not yet")
        for _ in 0..<50 where store.notice == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(store.notice, "No connection. Not yet will be sent when the iPhone is back online.")
        XCTAssertEqual(store.saved.outbox.map(\.decisionId), ["d_two"])
        // Queued: the typed reply has done its work (#1169).
        XCTAssertNil(store.drafts["d_two"])
        XCTAssertTrue(store.openDecisions.isEmpty)
        XCTAssertEqual(HistoryText.how(try XCTUnwrap(store.decision("d_two")), store), "You: Not yet · not sent yet")
        Offline.offline = false
        store.notice = nil
        await store.refresh()
        XCTAssertNil(store.notice)
        XCTAssertTrue(store.saved.outbox.isEmpty)
        XCTAssertEqual(store.decision("d_two")?.answer, "Not yet")
        got = try await answers()
        XCTAssertEqual(got.first { $0.decisionId == "d_two" }?.text, "Not yet")

        // --- From a notification's button, before the inbox read the question (#1137) ---
        try await ask("d_three")
        XCTAssertNil(store.decision("d_three"))
        await store.answerFromNotification("d_three", choice: "No", text: nil)
        XCTAssertEqual(store.decision("d_three")?.answer, "No")
        got = try await answers()
        XCTAssertEqual(got.first { $0.decisionId == "d_three" }?.choice, "No")

        // --- A Reply longer than the Answer schema takes is cut to it, and sent (#1169) ---
        try await ask("d_long")
        await store.answerFromNotification("d_long", choice: nil, text: String(repeating: "é", count: 3999) + "👍🏽!")
        got = try await answers()
        XCTAssertEqual(got.first { $0.decisionId == "d_long" }?.text, String(repeating: "é", count: 3999) + "👍")

        // --- An image, opened as the question is kept; then a snooze, and Back now (#1131) ---
        let png = Array("not really a png".utf8)
        let (blob, ref) = Images.seal(png)
        let pictured = try Envelopes.seal(kind: .decision, body: .object([
            "v": 1, "id": "d_four", "to": [.string(phone.id)], "createdAt": .string(now()), "question": "Which one?", "context": "",
            "options": [], "source": source,
            "images": [["key": .string(ref.key), "hash": .string(ref.hash), "type": "image/png", "width": 20, "height": 10]],
        ]), signer: machine.id, secretKey: keys.sign.secretKey, recipients: [phone])
        var withBlob = try XCTUnwrap(pictured.json.object)
        withBlob["blobs"] = [.string(blob)]
        try await call(machineToken, "POST", "/items", .object(withBlob))
        await store.refresh()
        XCTAssertEqual(store.decision("d_four")?.images.first?.bytes, Data(png))
        await store.snooze("d_four", until: Date().addingTimeInterval(3600))
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.snoozedDecisions.map(\.id), ["d_four"])
        XCTAssertFalse(store.openDecisions.contains { $0.id == "d_four" })
        await store.refresh()
        XCTAssertEqual(store.snoozedDecisions.map(\.id), ["d_four"])
        await store.snooze("d_four", until: Date())
        XCTAssertNil(store.notice)
        XCTAssertTrue(store.openDecisions.contains { $0.id == "d_four" })

        // --- The machine is revoked: its open question leaves, and so does its notification (#344, #1184) ---
        try await show("d_four")
        let revoke = Directories.revokeEntry(try await directory(), signer: phone.id, signKey: phoneSign, id: machine.id, at: now())
        try await call(phoneSession, "POST", "/directory", ["entry": revoke.json])
        await store.refresh()
        XCTAssertFalse(store.openDecisions.contains { $0.id == "d_four" })
        shown = await delivered()
        XCTAssertFalse(shown.contains("d_four"))
    }
}

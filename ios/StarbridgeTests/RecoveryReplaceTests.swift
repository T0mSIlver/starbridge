import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * Replacing the recovery key from Devices on a real self-hosted server (#348): only with the
 * current key, posted only once saved, and a replacement made on another device shows once. The
 * account is deleted afterwards (README.md, "Build and test").
 */
@MainActor
final class RecoveryReplaceTests: XCTestCase {
    func testReplaces() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STARBRIDGE_TEST_SERVER"], let token = env["STARBRIDGE_TEST_OWNER_TOKEN"] else {
            throw XCTSkip("no STARBRIDGE_TEST_SERVER")
        }
        let session = try await Api(server: server, session: nil).ownerSession(token: token)
        let empty = try await Api(server: server, session: session).directory(from: 0).isEmpty
        try XCTSkipUnless(empty, "the server's account already has devices")
        addTeardownBlock {
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
        guard case let .recoveryKey(first) = store.phase else { return XCTFail("no recovery key: \(store.phase)") }
        await store.confirmRecoveryKey()
        XCTAssertEqual(store.phase, .ready)
        let account = try XCTUnwrap(store.saved.account)
        let phone = try XCTUnwrap(store.me).member
        func recoveryPk() async throws -> String {
            try Directories.verify(try await store.api().directory(from: 0), account: account).recoveryPk
        }
        let firstPk = try await recoveryPk()
        XCTAssertEqual(store.recoveryInfo?.replaced, false)
        XCTAssertEqual(store.recoveryInfo?.setBy, "this iPhone")

        // Another account's key, or a typo, makes nothing.
        await store.newRecoveryKey(current: RecoveryKeys.encode(RecoveryKeys.generateSeed()))
        XCTAssertEqual(store.notice, "This isn't the account's current recovery key.")
        XCTAssertEqual(store.replacing, .idle)

        // Cancelled once shown, the new key never reaches the server.
        await store.newRecoveryKey(current: first.lowercased())
        guard case let .shown(dropped, saving: false) = store.replacing else { return XCTFail("\(store.replacing)") }
        store.closeRecoveryKey()
        XCTAssertEqual(store.replacing, .idle)
        await store.saveRecoveryKey()
        let afterCancel = try await recoveryPk()
        XCTAssertEqual(afterCancel, firstPk)
        XCTAssertNotEqual(dropped, first)

        // Saved, it replaces the key: the new one is the chain's, and this iPhone shows no notice of its own replacement.
        await store.newRecoveryKey(current: first)
        guard case let .shown(second, saving: false) = store.replacing else { return XCTFail("\(store.replacing)") }
        await store.saveRecoveryKey()
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.replacing, .done)
        let secondPk = try await recoveryPk()
        XCTAssertEqual(secondPk, toB64(RecoveryKeys.keyPair(try RecoveryKeys.seed(second)).publicKey))
        XCTAssertEqual(store.recoveryInfo?.replaced, true)
        XCTAssertEqual(store.recoveryInfo?.setBy, "this iPhone")
        XCTAssertNil(store.recoveryInfo?.notice)
        store.closeRecoveryKey()

        // The old key no longer counts.
        await store.newRecoveryKey(current: first)
        XCTAssertEqual(store.notice, "This isn't the account's current recovery key.")

        // Another device replaces it: the inbox says so once, until dismissed.
        let other = MemberKeys.generate()
        let laptop = Member(id: "d_laptop", role: .device, name: "Laptop", boxPk: toB64(other.box.publicKey), signPk: toB64(other.sign.publicKey))
        let sign = SecretKey(try fromB64(try XCTUnwrap(vault.secrets.signSk)))
        let api = store.api()
        func chain() async throws -> Directory { try Directories.verify(try await api.directory(from: 0), account: account) }
        try await api.append(Directories.addEntry(try await chain(), signer: phone.id, signKey: sign, member: laptop, at: store.now()).json)
        // The laptop signs in and binds its own session, since a device appends only entries it signed.
        let laptopApi = Api(server: server, session: try await Api(server: server, session: nil).ownerSession(token: token))
        let nonce = try await laptopApi.challenge()
        try await laptopApi.bind(member: laptop.id, sig: toB64(Sodium.sign(Pairings.bindMessage(account: account, member: laptop.id, nonce: nonce), secretKey: other.sign.secretKey)))
        let third = RecoveryKeys.keyPair(RecoveryKeys.generateSeed())
        try await laptopApi.append(Directories.recoveryEntry(try await chain(), signer: laptop.id, signKey: other.sign.secretKey, recovery: third, at: store.now()).json)
        let current = RecoveryKeys.keyPair(try RecoveryKeys.seed(second))
        try await laptopApi.append(try Directories.recoveryConfirmEntry(try await chain(), recoveryKey: current.secretKey, recoveryPk: toB64(third.publicKey), at: store.now()).json)
        await store.refresh()
        let notice = try XCTUnwrap(store.recoveryInfo?.notice)
        XCTAssertEqual(notice.by, "Laptop")
        XCTAssertEqual(store.recoveryInfo?.setBy, "Laptop")
        store.dismissRecoveryNotice(notice.seq)
        XCTAssertNil(store.recoveryInfo?.notice)
    }
}

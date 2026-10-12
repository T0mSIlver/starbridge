import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * On a real self-hosted server with an empty account: the app sets up the account's first
 * device, then a second app recovers it with the recovery key the first one showed. The account
 * is deleted afterwards, so JoinTests finds it empty again (README.md, "Test").
 */
@MainActor
final class FirstDeviceTests: XCTestCase {
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

    private func store(_ vault: MemoryVault, _ name: String) -> Store {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return Store(vault: vault, disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: name)
    }

    func testSetsUpTheFirstDeviceThenRecovers() async throws {
        let session = try await Api(server: server, session: nil).ownerSession(token: token)
        let owner = Api(server: server, session: session)
        let before = try await owner.directory(from: 0)
        try XCTSkipUnless(before.isEmpty, "the server's account already has devices")
        let account = try await owner.me().account
        addTeardownBlock { [server, token] in
            // A fresh owner session deletes the account; the next owner sign-in makes an empty one.
            let s = try? await Api(server: server, session: nil).ownerSession(token: token)
            var request = URLRequest(url: URL(string: server + "/v1/account")!)
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(s ?? "")", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: request)
        }

        // --- The first device ---
        let firstVault = MemoryVault()
        let first = store(firstVault, "First iPhone")
        await first.signInWaiting(server: server, token: token)
        XCTAssertEqual(first.phase, .noDevice(accountExists: false))
        await first.setUpFirstDevice()
        XCTAssertNil(first.notice)
        guard case let .recoveryKey(key) = first.phase else { return XCTFail("no recovery key: \(first.phase)") }
        // The server sees nothing until the owner says the key is stored (#370).
        let unposted = try await owner.directory(from: 0)
        XCTAssertTrue(unposted.isEmpty)
        await first.confirmRecoveryKey()
        XCTAssertNil(first.notice)
        XCTAssertEqual(first.phase, .ready)
        XCTAssertNil(firstVault.secrets.recoverySeed)
        let dir = try Directories.verify(await owner.directory(from: 0), account: account)
        let firstId = try XCTUnwrap(first.me?.id)
        XCTAssertEqual(dir.active(.device).map(\.id), [firstId])
        let firstBound = try await Api(server: server, session: firstVault.secrets.session).me().member
        XCTAssertEqual(firstBound, firstId)

        // --- Recovering on another iPhone ---
        let secondVault = MemoryVault()
        let second = store(secondVault, "Second iPhone")
        await second.signInWaiting(server: server, token: token)
        XCTAssertEqual(second.phase, .noDevice(accountExists: true))
        // Another key, valid as a key but not this account's.
        await second.recover(RecoveryKeys.encode(RecoveryKeys.generateSeed()))
        XCTAssertEqual(second.notice, "This is a recovery key, but not this account's current one.")
        XCTAssertEqual(second.phase, .noDevice(accountExists: true))
        await second.recover(key.lowercased())
        XCTAssertNil(second.notice)
        XCTAssertEqual(second.phase, .ready)
        let secondId = try XCTUnwrap(second.me?.id)
        let after = try Directories.verify(await owner.directory(from: 0), account: account)
        // Recovery revokes every other member (#363).
        XCTAssertEqual(after.active(.device).map(\.id), [secondId])
        XCTAssertEqual(after.members[firstId]?.active, false)
        let secondBound = try await Api(server: server, session: secondVault.secrets.session).me().member
        XCTAssertEqual(secondBound, secondId)

        // --- Delete account: the server forgets it, and so does the iPhone (#1141) ---
        let deleted = try XCTUnwrap(secondVault.secrets.session)
        await second.deleteAccount()
        XCTAssertNil(second.notice)
        XCTAssertEqual(second.phase, .signedOut)
        XCTAssertEqual(secondVault.secrets, Secrets())
        // Its sessions went with it. (No new owner sign-in: the suite stays under 10 a minute.)
        do {
            _ = try await Api(server: server, session: deleted).me()
            XCTFail("the deleted account's session still works")
        } catch let e as ApiError {
            XCTAssertEqual(e.status, 401)
        }
    }
}

import SwiftUI
import XCTest
@testable import Starbridge

/** Presence (#848): when the beacon says present or absent, and the account's hold time on a real server. */
@MainActor
final class PresenceTests: XCTestCase {
    func testBeacon() async {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        var sent: [Bool] = []
        let beacon = Beacon(send: { sent.append($0) }, now: { clock })

        // Never touched: nothing to say.
        await beacon.tick(inFront: true)
        XCTAssertEqual(sent, [])
        // A touch makes it present at once; another within the minute changes nothing.
        XCTAssertTrue(beacon.input(inFront: true))
        await beacon.tick(inFront: true)
        XCTAssertEqual(sent, [true])
        clock += 10
        XCTAssertFalse(beacon.input(inFront: true))
        await beacon.tick(inFront: true)
        XCTAssertEqual(sent, [true])
        // Again once a beat passed.
        clock += 25
        await beacon.tick(inFront: true)
        XCTAssertEqual(sent, [true, true])
        // A minute after the last touch, absent, once.
        clock += 40
        await beacon.tick(inFront: true)
        await beacon.tick(inFront: true)
        XCTAssertEqual(sent, [true, true, false])
        // Sent behind, a touch makes nothing present; leaving says absent at once.
        XCTAssertFalse(beacon.input(inFront: false))
        await beacon.tick(inFront: true)
        await beacon.tick(inFront: false)
        XCTAssertEqual(sent, [true, true, false, true, false])
        // A failed beat is tried a beat later, not at every check.
        var fails = 0
        let failing = Beacon(send: { _ in fails += 1; throw URLError(.notConnectedToInternet) }, now: { clock })
        _ = failing.input(inFront: true)
        await failing.tick(inFront: true)
        clock += 10
        await failing.tick(inFront: true)
        XCTAssertEqual(fails, 1)
        clock += 20
        await failing.tick(inFront: true)
        XCTAssertEqual(fails, 2)
    }

    /** The tabs put a watcher on their window that takes no touch, and say the app is in front. */
    func testWatchesTouches() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first)
        window.rootViewController = UIHostingController(rootView: MainTabs(store: store).environment(\.scenePhase, .active))
        addTeardownBlock { @MainActor in window.rootViewController = UIViewController() }
        try await Task.sleep(for: .seconds(1))
        let watcher = try XCTUnwrap(window.gestureRecognizers?.first { $0 is TouchWatcher } as? TouchWatcher)
        XCTAssertFalse(watcher.cancelsTouchesInView)
        XCTAssertTrue(store.inFront)
    }

    func testHoldLabels() {
        XCTAssertEqual(Beacon.holdChoices.map(Beacon.holdLabel), ["Off", "0 s", "15 s", "30 s", "1 min"])
    }

    func testHoldTime() async throws {
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
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        await store.signInWaiting(server: server, token: token)
        await store.setUpFirstDevice()
        await store.confirmRecoveryKey()
        XCTAssertEqual(store.phase, .ready)

        await store.loadPushHold()
        XCTAssertEqual(store.pushHold, 30)
        await store.setPushHold(Beacon.holdOnLeave)
        XCTAssertNil(store.notice)
        XCTAssertEqual(store.pushHold, -1)
        store.pushHold = nil
        await store.loadPushHold()
        XCTAssertEqual(store.pushHold, -1)
        // The server takes the bit.
        try await store.api().presence(true)
        try await store.api().presence(false)
    }
}

import StarbridgeProtocol
import XCTest
@testable import Starbridge

/**
 * The iPhone approves joins by digits on a real self-hosted server (#1158): a second iPhone app
 * asks, both show the same digits, and the first approves it into the account; a third ask is
 * refused. The account is deleted afterwards (README.md, "Build and test").
 */
@MainActor
final class JoinApproveTests: XCTestCase {
    private func until(_ what: String, _ check: () -> Bool) async throws {
        for _ in 0..<100 where !check() { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertTrue(check(), what)
    }

    func testApprovesAndRefuses() async throws {
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
        func store(_ name: String) -> Store {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
            return Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: name)
        }
        let phone = store("First iPhone")
        await phone.signInWaiting(server: server, token: token)
        await phone.setUpFirstDevice()
        await phone.confirmRecoveryKey()
        XCTAssertEqual(phone.phase, .ready)
        phone.watchJoins(true)
        addTeardownBlock { @MainActor in phone.watchJoins(false) }

        // --- A second iPhone asks; both show the same digits; the first approves ---
        let second = store("Second iPhone")
        await second.signInWaiting(server: server, token: token)
        XCTAssertEqual(second.phase, .noDevice(accountExists: true))
        await second.askDevices()
        try await until("the ask is listed") { phone.joinAsks.contains { $0.name == "Second iPhone" } }
        let ask = try XCTUnwrap(phone.joinAsks.first { $0.name == "Second iPhone" })
        XCTAssertFalse(ask.elsewhere)
        phone.compareJoin(ask.id)
        try await until("the digits show") { if case .digits = phone.comparison { true } else { false } }
        guard case let .digits(_, mine, false, nil) = phone.comparison else { return XCTFail("\(phone.comparison)") }
        try await until("the joiner shows digits") { second.phase == .joiningByDigits(digits: mine, matched: false) }
        second.confirmDigits()
        await phone.approveJoin()
        XCTAssertEqual(phone.comparison, .done("Second iPhone joined."))
        try await until("the second iPhone is in") { second.phase == .ready }
        XCTAssertEqual(phone.devices.map(\.name), ["First iPhone", "Second iPhone"])
        phone.closeComparison()
        XCTAssertEqual(phone.comparison, .idle)

        // --- A third asks; refused, it says so and stays out ---
        let third = store("Stranger")
        await third.signInWaiting(server: server, token: token)
        await third.askDevices()
        try await until("the third ask is listed") { phone.joinAsks.contains { $0.name == "Stranger" } }
        let refused = try XCTUnwrap(phone.joinAsks.first { $0.name == "Stranger" })
        await phone.refuseJoin(refused.id)
        XCTAssertEqual(phone.comparison, .done("Refused Stranger."))
        try await until("the third is told") { third.phase == .noDevice(accountExists: true) }
        XCTAssertEqual(third.notice, "The request was refused or cancelled. Ask again.")
        await phone.refreshDirectory()
        XCTAssertEqual(phone.devices.count, 2)
    }
}

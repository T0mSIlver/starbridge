import XCTest
@testable import Starbridge

/** Fails every request: the iPhone has no connection. */
final class NoNetwork: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}

/** Answering from a notification's buttons, with no server to reach. */
@MainActor
final class PushTests: XCTestCase {
    /** A prompt the inbox never read, denied offline: the deny was not sent, so its notification stays and says so (#1156). */
    func testAnOfflineDenyOfAnUnreadPromptKeepsTheNotification() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NoNetwork.self]
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_1")
        let store = Store(vault: vault, disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone", http: URLSession(configuration: config))
        let note = await store.denyFromNotification("p_unread")
        XCTAssertEqual(note, "Deny not sent: Can't reach \(Store.defaultServer). Check the connection and try again.")
        XCTAssertNil(store.notice)
    }
}

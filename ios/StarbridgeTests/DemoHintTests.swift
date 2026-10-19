import XCTest
@testable import Starbridge

/** Add this iPhone says how to join only for the server that said it is a demo (#2089). */
@MainActor
final class DemoHintTests: XCTestCase {
    func testTheHintHoldsOnlyForTheServerThatSaidSo() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Scripted.self]
        Scripted.replies = []
        Scripted.body = #"{"demo":true}"#
        defer { Scripted.body = nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "s")
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        var saved = Saved(server: "https://demo.example.test")
        saved.account = "a_1"
        saved.accountExists = true
        try disk.save(saved)
        // At launch on Add this iPhone, the store asks by itself.
        let store = Store(vault: vault, disk: disk, deviceName: "Test iPhone", http: URLSession(configuration: config))
        for _ in 0..<50 where !store.demo { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertTrue(store.demo)
        // Another server is no demo, before it is asked.
        _ = store.gitHubSignInURL(server: "https://other.example.test")
        XCTAssertFalse(store.demo)
    }
}

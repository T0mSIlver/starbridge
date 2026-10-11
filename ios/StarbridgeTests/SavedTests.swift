import XCTest
@testable import Starbridge

/** A saved state this release cannot read is kept aside, never replaced (#473, #1159). */
@MainActor
final class SavedTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private var file: URL { dir.appendingPathComponent("saved.json") }

    private func signedIn() -> MemoryVault {
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_1", signSk: "key")
        return vault
    }

    private func asideFiles() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasPrefix("saved.json.unreadable-") }
    }

    func testAFileWithoutFormatReadsAsFormatOneAndSavesItsFormat() throws {
        try Data(#"{"server":"https://example.test","account":"a_1","outbox":[]}"#.utf8).write(to: file)
        let store = Store(vault: signedIn(), disk: Disk(url: file), deviceName: "Test iPhone")
        XCTAssertEqual(store.saved.account, "a_1")
        XCTAssertNil(store.notice)
        XCTAssertEqual(try asideFiles(), [])
        var s = store.saved
        s.cursor = "c_1"
        store.persist(s)
        let written = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        XCTAssertEqual(written?["v"] as? Int, Saved.format)
    }

    func testADamagedOrNewerFileMovesAsideWithTheKeysAndTheAppStartsSignedOut() throws {
        for content in [#"{"server":"#, #"{"v":2,"server":"https://example.test","account":"a_1"}"#] {
            try setUpWithError()
            try Data(content.utf8).write(to: file)
            let vault = signedIn()
            let store = Store(vault: vault, disk: Disk(url: file), deviceName: "Test iPhone")
            XCTAssertEqual(store.phase, .signedOut)
            XCTAssertNotNil(store.notice)
            let aside = try asideFiles()
            XCTAssertEqual(aside.count, 1)
            XCTAssertEqual(try String(contentsOf: aside[0], encoding: .utf8), content)
            XCTAssertEqual(vault.secrets, Secrets())
            XCTAssertEqual(Array(vault.aside.values), [Secrets(session: "sb_1", signSk: "key")])
            XCTAssertEqual(vault.aside.keys.first.map { "saved.json.unreadable-\($0)" }, aside[0].lastPathComponent)
            // The next save writes a new file beside the kept one.
            var fresh = store.saved
            fresh.cursor = "c_1"
            store.persist(fresh)
            XCTAssertEqual(try asideFiles(), aside)
            XCTAssertEqual(Disk(url: file).load()?.cursor, "c_1")
            try tearDownWithError()
        }
    }

    /** A file there but not readable, as before the first unlock, stays, and nothing is written this run. */
    func testAFileThatCannotBeReadStaysAndNothingIsWritten() throws {
        // A folder in the file's place: there, but Data(contentsOf:) fails.
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        let vault = signedIn()
        let store = Store(vault: vault, disk: Disk(url: file), deviceName: "Test iPhone")
        XCTAssertNotNil(store.notice)
        XCTAssertEqual(try asideFiles(), [])
        XCTAssertEqual(vault.aside, [:])
        store.persist(Saved(server: "https://other.test"), Secrets())
        XCTAssertEqual(vault.secrets, Secrets(session: "sb_1", signSk: "key"))
        XCTAssertTrue(store.notice?.hasPrefix("This iPhone’s saved state couldn’t be read") == true)
        var isFolder: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path, isDirectory: &isFolder) && isFolder.boolValue)
    }

    /** Keys that could not follow the file aside are not overwritten: nothing is written this run. */
    func testKeysThatCannotBeSetAsideAreKeptAndNothingIsWritten() throws {
        try Data(#"{"server":"#.utf8).write(to: file)
        let vault = signedIn()
        vault.asideFails = true
        let store = Store(vault: vault, disk: Disk(url: file), deviceName: "Test iPhone")
        XCTAssertEqual(try asideFiles().count, 1)
        XCTAssertTrue(store.notice?.contains("keychain: locked") == true)
        store.persist(Saved(server: "https://other.test"), Secrets())
        XCTAssertEqual(vault.secrets, Secrets(session: "sb_1", signSk: "key"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}

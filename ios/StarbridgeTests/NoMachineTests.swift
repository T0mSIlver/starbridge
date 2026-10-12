import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** A new account's empty inbox says how to add a machine (#1370). */
@MainActor
final class NoMachineTests: XCTestCase {
    private func row(_ id: String, machine: Bool) -> DeviceRow {
        DeviceRow(id: id, name: id, machine: machine, addedAt: Date(), current: !machine, check: nil)
    }

    func testShowsOnlyOnceTheDirectoryHoldsNoMachine() {
        // Not read yet: nothing to say.
        XCTAssertFalse(NoMachine.shows([]))
        XCTAssertTrue(NoMachine.shows([row("d_phone", machine: false)]))
        XCTAssertFalse(NoMachine.shows([row("d_phone", machine: false), row("m_box", machine: true)]))
    }

    func testTheInstallCommandIsTheServersOwn() {
        XCTAssertEqual(NoMachine.install("https://sb.example.com/"), "curl -fsSL https://sb.example.com/install.sh | sh")
        XCTAssertEqual(NoMachine.install("https://starbridge.run"), "curl -fsSL https://starbridge.run/install.sh | sh")
    }

    /** At launch, before any sync and with no network, the saved chain says there is no machine. */
    func testShowsAtLaunchFromTheSavedChain() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let f = try NotifyFixture()
        var saved = f.saved
        saved.entries = [saved.entries[0]]
        let first = try Directories.verify([try JSON.parse(saved.entries[0])], account: "acct")
        saved.pin = Pin(length: first.length, head: first.head)
        let disk = Disk(url: dir.appendingPathComponent("saved.json"))
        try disk.save(saved)
        let vault = MemoryVault()
        vault.secrets = f.secrets
        XCTAssertTrue(NoMachine.shows(Store(vault: vault, disk: disk, deviceName: "Test iPhone").devices))

        try disk.save(f.saved)
        XCTAssertFalse(NoMachine.shows(Store(vault: vault, disk: disk, deviceName: "Test iPhone").devices))
    }
}

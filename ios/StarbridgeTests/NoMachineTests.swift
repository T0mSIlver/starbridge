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
}

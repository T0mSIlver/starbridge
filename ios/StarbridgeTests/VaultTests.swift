import XCTest
@testable import Starbridge

final class VaultTests: XCTestCase {
    private let vault = KeychainVault(service: "dev.starbridge.ios.tests", account: "vault-tests")

    override func tearDownWithError() throws { try vault.save(Secrets()) }

    func testSecretsRoundTripThroughTheKeychain() throws {
        XCTAssertEqual(try vault.load(), Secrets())
        var secrets = Secrets(session: "sb_1")
        secrets.signSk = "key"
        try vault.save(secrets)
        XCTAssertEqual(try vault.load(), secrets)
        // A second save replaces the item rather than adding one.
        secrets.session = "sb_2"
        try vault.save(secrets)
        XCTAssertEqual(try vault.load(), secrets)
        try vault.save(Secrets())
        XCTAssertEqual(try vault.load(), Secrets())
    }

    /** An update finds the item an earlier build kept outside the app group, and moves it in. */
    func testMovesAnEarlierBuildsItemIntoTheGroup() throws {
        let old = KeychainVault(service: vault.service, account: vault.account, group: nil)
        try old.save(Secrets(session: "sb_old"))
        XCTAssertEqual(try vault.load(), Secrets(session: "sb_old"))
        // Moved, not copied: clearing the group's item leaves nothing behind.
        try vault.save(Secrets())
        XCTAssertEqual(try vault.load(), Secrets())
    }

    /** An unreadable saved state takes its keys aside with it (#1159). */
    func testSetAsideKeepsTheSecretsUnderTheTag() throws {
        let aside = KeychainVault(service: vault.service, account: "\(vault.account).unreadable-1")
        addTeardownBlock { try? aside.save(Secrets()) }
        try vault.save(Secrets(session: "sb_1"))
        try vault.setAside("1")
        XCTAssertEqual(try vault.load(), Secrets())
        XCTAssertEqual(try aside.load(), Secrets(session: "sb_1"))
    }
}

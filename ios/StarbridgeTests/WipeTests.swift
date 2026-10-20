import StarbridgeProtocol
import UserNotifications
import XCTest
@testable import Starbridge

/** Sign out and Delete account forget what the account left on the iPhone beyond its keys (#2013). */
@MainActor
final class WipeTests: XCTestCase {
    func testWipeClearsDeliveredNotificationsCategoriesQuotaSettingsAndTheBadge() async throws {
        let center = UNUserNotificationCenter.current()
        _ = try await center.requestAuthorization(options: [.provisional, .alert, .badge])
        func delivered() async -> Set<String> { Set(await center.deliveredNotifications().map(\.request.identifier)) }
        func categories() async -> Set<String> { Set(await center.notificationCategories().map(\.identifier)) }

        // A question as the extension left it: its text in Notification Center, its answers as buttons.
        await Notify.post("d_secret", kind: "decision", title: "Drop the prod table?", subtitle: nil, body: "")
        await Notify.register("d.d_secret", [NotificationAction(id: "a0", title: "Drop it")])
        for _ in 0..<50 where await !delivered().contains("d_secret") { try await Task.sleep(for: .milliseconds(100)) }
        // A snoozed question's return waits as a pending request.
        let later = UNMutableNotificationContent()
        later.title = "Drop the prod table?"
        try await center.add(UNNotificationRequest(identifier: "snooze-d_secret", content: later, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: false)))
        let pending = await center.pendingNotificationRequests().map(\.identifier)
        XCTAssertTrue(pending.contains("snooze-d_secret"))
        let before = await delivered()
        XCTAssertTrue(before.contains("d_secret"))
        let registered = await categories()
        XCTAssertTrue(registered.contains("d.d_secret"))

        var settings = QuotaSettings()
        settings.alerts.short = ["codex/5h"]
        settings.store()
        XCTAssertTrue(QuotaShown.first("codex/5h/90"))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: QuotaSettings.key))

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        store.wipe()

        XCTAssertNil(UserDefaults.standard.data(forKey: QuotaSettings.key))
        XCTAssertNil(UserDefaults.standard.stringArray(forKey: QuotaShown.key))
        XCTAssertEqual(store.quotaSettings, QuotaSettings())
        for _ in 0..<50 {
            let left = await delivered()
            let cats = await categories()
            let waiting = await center.pendingNotificationRequests()
            if left.isEmpty && cats.isEmpty && waiting.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let left = await delivered()
        let cats = await categories()
        XCTAssertTrue(left.isEmpty, "delivered: \(left)")
        XCTAssertTrue(cats.isEmpty, "categories: \(cats)")
        let waiting = await center.pendingNotificationRequests().map(\.identifier)
        XCTAssertTrue(waiting.isEmpty, "pending: \(waiting)")
    }
}

/** What sign-out and a reinstall leave of the keys (security audit 2026-10-20, L5). */
@MainActor
final class WipeKeysTests: XCTestCase {
    private func scratch() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testSignOutDeletesTheCopiesSetAsideAfterAnUnreadableLaunch() throws {
        let dir = scratch()
        let url = dir.appendingPathComponent("saved.json")
        try Data("not json".utf8).write(to: url)
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_old")
        // The unreadable state and its keys go aside; the app starts signed out.
        let store = Store(vault: vault, disk: Disk(url: url), deviceName: "Test iPhone")
        XCTAssertEqual(vault.aside.count, 1)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: dir.path).contains { $0.hasPrefix("saved.json.unreadable-") })
        store.wipe()
        XCTAssertTrue(vault.aside.isEmpty)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: dir.path).contains { $0.hasPrefix("saved.json.unreadable-") })
    }

    func testSignOutWhileLockedStillDeletesTheKeys() throws {
        let dir = scratch()
        let url = dir.appendingPathComponent("saved.json")
        try Data("not json".utf8).write(to: url)
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_old")
        vault.asideFails = true
        // The keys could not go aside: nothing is written this run.
        let store = Store(vault: vault, disk: Disk(url: url), deviceName: "Test iPhone")
        XCTAssertEqual(vault.secrets.session, "sb_old")
        store.wipe()
        XCTAssertEqual(vault.secrets, Secrets())
        XCTAssertEqual(store.phase, .signedOut)
    }

    func testAKeychainWipeTakesEveryItemOfTheService() throws {
        let main = KeychainVault(service: "dev.starbridge.ios.wipe-tests", account: "secrets")
        let aside = KeychainVault(service: main.service, account: "secrets.unreadable-1")
        addTeardownBlock { try? main.wipe() }
        try main.save(Secrets(session: "sb_1"))
        try aside.save(Secrets(session: "sb_0"))
        try main.wipe()
        XCTAssertEqual(try main.load(), Secrets())
        XCTAssertEqual(try aside.load(), Secrets())
    }

    func testAReinstallsFirstLaunchForgetsTheKeysADeletedInstallLeft() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let disk = Disk(url: scratch().appendingPathComponent("saved.json"))
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_left")
        Store.forgetAfterReinstall(vault: vault, disk: disk, defaults: defaults)
        XCTAssertEqual(vault.secrets, Secrets())
        // Once installed, a later launch keeps them, saved state or not.
        vault.secrets = Secrets(session: "sb_new")
        Store.forgetAfterReinstall(vault: vault, disk: disk, defaults: defaults)
        XCTAssertEqual(vault.secrets.session, "sb_new")
    }

    func testAnUpdateKeepsItsKeys() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let disk = Disk(url: scratch().appendingPathComponent("saved.json"))
        try disk.save(Saved(server: "https://starbridge.run"))
        let vault = MemoryVault()
        vault.secrets = Secrets(session: "sb_kept")
        Store.forgetAfterReinstall(vault: vault, disk: disk, defaults: defaults)
        XCTAssertEqual(vault.secrets.session, "sb_kept")
    }
}

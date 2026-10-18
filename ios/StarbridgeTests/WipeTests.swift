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
            if left.isEmpty && cats.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let left = await delivered()
        let cats = await categories()
        XCTAssertTrue(left.isEmpty, "delivered: \(left)")
        XCTAssertTrue(cats.isEmpty, "categories: \(cats)")
    }
}

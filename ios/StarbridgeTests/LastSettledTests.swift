import StarbridgeProtocol
import SwiftUI
import XCTest
@testable import Starbridge

/**
 * A question's sheet settled elsewhere while it shows (#1587): the last item that needed the owner
 * closes onto the empty inbox, as on web (#1583); with others still open, it stays to say how it closed.
 */
@MainActor
final class LastSettledTests: XCTestCase {
    private func question(_ id: String, _ text: String) throws -> SavedDecision {
        let body: JSONObject = [
            "v": 1, "id": .string(id), "to": ["p_1"], "createdAt": "2026-10-13T08:00:00.000Z", "question": .string(text),
            "context": "", "options": ["Ship", "Hold"], "recommended": "Ship", "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
        ]
        return try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: nil)
    }

    /** The inbox with [decisions] and the sheet of the first open over it. */
    private func show(_ decisions: [SavedDecision]) async throws -> (Store, UIWindow) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        var saved = store.saved
        saved.decisions = decisions
        store.persist(saved)
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first)
        window.rootViewController = UIHostingController(rootView: InboxView(store: store).environment(\.scenePhase, .active))
        addTeardownBlock { @MainActor in window.rootViewController = UIViewController() }
        try await Task.sleep(for: .seconds(1))
        store.openRequest = .decision(decisions[0].id)
        try await until { window.rootViewController?.presentedViewController != nil }
        return (store, window)
    }

    private func withdraw(_ store: Store, _ id: String) {
        var saved = store.saved
        saved.decisions = saved.decisions.map { d in
            guard d.id == id else { return d }
            var settled = d
            settled.answeredAt = "2026-10-13T08:01:00.000Z"
            settled.settled = "withdrawn"
            settled.reason = "Done by hand"
            return settled
        }
        store.persist(saved)
    }

    private func until(_ done: () -> Bool) async throws {
        for _ in 0..<50 where !done() { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertTrue(done())
    }

    func testTheLastOneClosesOntoTheEmptyInbox() async throws {
        let (store, window) = try await show([question("d_ship", "Ship the release?")])
        withdraw(store, "d_ship")
        try await until { window.rootViewController?.presentedViewController == nil }
    }

    func testWithAnotherOpenItStaysSayingHowItClosed() async throws {
        let (store, window) = try await show([question("d_ship", "Ship the release?"), question("d_docs", "Merge the docs?")])
        withdraw(store, "d_ship")
        try await Task.sleep(for: .seconds(2))
        XCTAssertNotNil(window.rootViewController?.presentedViewController)
    }
}

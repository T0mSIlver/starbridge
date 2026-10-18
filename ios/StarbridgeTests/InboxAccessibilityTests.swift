import Darwin
import StarbridgeProtocol
import SwiftUI
import XCTest
@testable import Starbridge

/** What VoiceOver gets from the inbox's cards (#1946): one stop with the machine, the ask, how long it waited, and the way in. */
@MainActor
final class InboxAccessibilityTests: XCTestCase {
    private let source: JSONObject = ["machine": "devbox", "project": "starbridge", "session": "s1"]

    private func question() throws -> SavedDecision {
        let body: JSONObject = [
            "v": 1, "id": "d_ship", "to": ["p_1"], "createdAt": "2026-10-13T08:00:00.000Z", "question": "Ship the release?",
            "context": "", "options": ["Ship", "Hold"], "recommended": "Ship", "source": .object(source),
        ]
        var d = try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: nil)
        d.waiting = "waiting"
        d.waitingAt = Dates.format(Date().addingTimeInterval(-300))
        return d
    }

    private func prompt() throws -> SavedPrompt {
        let now = Date()
        let body: JSONObject = [
            "v": 1, "id": "p_push", "to": ["p_1"], "createdAt": .string(Dates.format(now.addingTimeInterval(-300))), "agent": "claude-code", "tool": "Bash",
            "summary": "git push", "input": "{}", "inputHash": .string(String(repeating: "A", count: 43)), "suggestions": [],
            "expiresAt": .string(Dates.format(now.addingTimeInterval(240))), "source": .object(source),
        ]
        return try SavedPrompt(from: "m_2", text: JSON.object(body).text, answeredAt: nil)
    }

    /** SwiftUI builds its accessibility tree only when a client asks, as VoiceOver or XCUITest do. */
    private func switchAccessibilityOn() {
        guard let lib = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW) else { return }
        for name in ["_AXSSetAutomationEnabled", "_AXSApplicationAccessibilitySetEnabled"] {
            if let sym = dlsym(lib, name) { unsafeBitCast(sym, to: (@convention(c) (Bool) -> Void).self)(true) }
        }
    }

    /** The accessibility elements under [node], in the order VoiceOver walks them. */
    private func elements(_ node: NSObject, _ out: inout [NSObject]) {
        if node.isAccessibilityElement { out.append(node); return }
        var kids: [NSObject] = []
        if let e = node.accessibilityElements, !e.isEmpty {
            kids = e.compactMap { $0 as? NSObject }
        } else {
            let n = node.accessibilityElementCount()
            if n > 0, n != NSNotFound { kids = (0..<n).compactMap { node.accessibilityElement(at: $0) as? NSObject } }
        }
        if kids.isEmpty, let v = node as? UIView { kids = v.subviews.filter { !$0.isHidden } }
        for k in kids { elements(k, &out) }
    }

    private func voiceOverStops() async throws -> (stops: [NSObject], window: UIWindow) {
        switchAccessibilityOn()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let store = Store(vault: MemoryVault(), disk: Disk(url: dir.appendingPathComponent("saved.json")), deviceName: "Test iPhone")
        var saved = store.saved
        saved.decisions = [try question()]
        saved.prompts = [try prompt()]
        store.persist(saved)
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first)
        window.rootViewController = UIHostingController(rootView: InboxView(store: store).environment(\.scenePhase, .active))
        addTeardownBlock { @MainActor in window.rootViewController = UIViewController() }
        try await Task.sleep(for: .seconds(2))
        var stops: [NSObject] = []
        elements(try XCTUnwrap(window.rootViewController?.view), &stops)
        return (stops, window)
    }

    private func describe(_ stops: [NSObject]) -> String {
        stops.map { "[\($0.accessibilityLabel ?? "-") | \($0.accessibilityValue ?? "-") | \(($0.accessibilityCustomActions ?? []).map(\.name))]" }.joined(separator: " ")
    }

    /** Runs the named custom action the way VoiceOver's actions rotor does; the card opens its sheet. */
    private func perform(_ name: String, on stop: NSObject, in window: UIWindow, _ stops: [NSObject]) async throws {
        let action = try XCTUnwrap((stop.accessibilityCustomActions ?? []).first { $0.name == name }, describe(stops))
        XCTAssertNil(window.rootViewController?.presentedViewController)
        _ = action.actionHandler?(action)
        for _ in 0..<50 where window.rootViewController?.presentedViewController == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertNotNil(window.rootViewController?.presentedViewController, "\(name) opened nothing")
    }

    func testAQuestionIsOneStopWithItsWaitingTimeAndWayIn() async throws {
        let (stops, window) = try await voiceOverStops()
        let stop = try XCTUnwrap(stops.first { ($0.accessibilityLabel ?? "").contains("Ship the release?") }, describe(stops))
        XCTAssertEqual(stop.accessibilityLabel?.contains("devbox · starbridge"), true, describe(stops))
        XCTAssertEqual(stop.accessibilityValue, "Waiting for you, 5 minutes", describe(stops))
        XCTAssertTrue(stop.accessibilityTraits.contains(.button), describe(stops))
        // The answers stay stops of their own.
        for label in ["Ship", "Hold"] {
            let option = try XCTUnwrap(stops.first { $0.accessibilityLabel == label }, describe(stops))
            XCTAssertTrue(option.accessibilityTraits.contains(.button), describe(stops))
        }
        try await perform("Open the question", on: stop, in: window, stops)
    }

    func testAPromptIsOneStopWithItsWaitingTimeAndWayIn() async throws {
        let (stops, window) = try await voiceOverStops()
        let stop = try XCTUnwrap(stops.first { ($0.accessibilityLabel ?? "").contains("Bash") }, describe(stops))
        XCTAssertEqual(stop.accessibilityValue, "Waiting for you, 5 minutes", describe(stops))
        XCTAssertTrue(stop.accessibilityTraits.contains(.button), describe(stops))
        for label in ["Deny", "Allow"] {
            XCTAssertNotNil(stops.first { $0.accessibilityLabel == label }, describe(stops))
        }
        try await perform("Open the prompt", on: stop, in: window, stops)
    }
}

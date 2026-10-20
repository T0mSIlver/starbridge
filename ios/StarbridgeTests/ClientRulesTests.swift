import StarbridgeProtocol
import XCTest
@testable import Starbridge

/** The app's rules against packages/protocol/vectors/rules.json, which the web's and Android's tests read too (#1429). */
@MainActor
final class ClientRulesTests: XCTestCase {
    private let rules: JSON = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../packages/protocol/vectors/rules.json").standardizedFileURL
        return try! JSON.parse(String(decoding: try! Data(contentsOf: url), as: UTF8.self))
    }()

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Paris")!
        return c
    }()

    /** "2026-10-12T10:20", in the test's zone. */
    private func local(_ s: JSON?) -> Date {
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.date(from: s!.string!)!
    }

    private func ms(_ s: TimeInterval) -> Double { s * 1000 }

    func testPresenceRetryAndRowLimits() {
        let presence = rules["presence"]!
        XCTAssertEqual(presence["inputMs"]!.number, ms(Beacon.inputWindow))
        XCTAssertEqual(presence["beatMs"]!.number, ms(Beacon.beat))
        XCTAssertEqual(presence["checkMs"]!.number, ms(Beacon.check))
        XCTAssertEqual(presence["holdChoices"]!.array!.map { Int($0.number!) }, Beacon.holdChoices)
        XCTAssertEqual(rules["retryForMs"]!.number, ms(Api.retryFor))
        XCTAssertEqual(rules["rowInputMax"]!.number, Double(SavedPrompt.rowInputMax))
    }

    func testLimits() {
        let limits = rules["limits"]!
        XCTAssertEqual(limits["answerTextMax"]!.number, Double(ANSWER_TEXT_MAX))
        XCTAssertEqual(limits["blobMax"]!.number, Double(BLOB_MAX))
    }

    func testSnooze() {
        let snooze = rules["snooze"]!
        XCTAssertEqual(snooze["minMs"]!.number, ms(SnoozeTimes.minimum))
        XCTAssertEqual(snooze["maxMs"]!.number, ms(SnoozeTimes.maximum))
        for c in snooze["presets"]!.array! {
            let got = SnoozeTimes.presets(local(c["now"]), calendar)
            let want = c["presets"]!.array!.map { ($0.array![0].string!, local($0.array![1])) }
            XCTAssertEqual(got.map(\.0), want.map(\.0), c["now"]!.string!)
            XCTAssertEqual(got.map(\.1), want.map(\.1), c["now"]!.string!)
        }
        for c in snooze["allowed"]!.array! {
            XCTAssertEqual(SnoozeTimes.allowed(local(c["until"]), local(c["now"])), c["allowed"]!.bool, "\(c["now"]!.string!) → \(c["until"]!.string!)")
        }
        for c in snooze["morning"]!.array! {
            XCTAssertEqual(SwipeSnooze.morning.until(local(c["now"]), calendar), local(c["morning"]), c["now"]!.string!)
        }
    }

    func testOrder() {
        let order = rules["order"]!
        for c in order["snooze"]!.array! {
            let kept = c["kept"], next = c["next"]!
            XCTAssertEqual(Order.laterSnooze(keptAt: kept?["at"]?.string, keptUntil: kept?["until"]?.string, at: next["at"]!.string!, until: next["until"]!.string!), c["later"]!.bool!, c["name"]!.string!)
        }
        for c in order["waiting"]!.array! {
            let kept = c["kept"], next = c["next"]!
            XCTAssertEqual(Order.laterWaiting(keptAt: kept?["at"]?.string, keptState: kept?["state"]?.string, at: next["at"]!.string!, state: next["state"]!.string!), c["later"]!.bool!, c["name"]!.string!)
        }
        // The app stamps whole seconds.
        for c in order["stamp"]!.array! {
            let now = Dates.parse(c["now"]!.string!)!
            XCTAssertEqual(SnoozeStamps.of(until: now.addingTimeInterval(3600), last: c["last"]?.string, now: now).at, c["seconds"]!.string!, c["name"]!.string!)
        }
    }

    /** notify.ts's rule, step by step; a restart is a round trip through JSON (#2151). */
    func testNotify() throws {
        for c in rules["notify"]!.array! {
            var kept = Notified()
            for (i, step) in c["steps"]!.array!.enumerated() {
                if step["restart"] != nil {
                    kept = try JSONDecoder().decode(Notified.self, from: JSONEncoder().encode(kept))
                    continue
                }
                let (next, effect) = Order.notifyStep(kept, NotifyRulesCase.event(step["push"]!))
                XCTAssertEqual(effect.rawValue, step["effect"]!.string!, "\(c["name"]!.string!), step \(i)")
                kept = next
            }
        }
    }

    func testOptionsRecommendedFirst() throws {
        for c in rules["options"]!.array! {
            var body: JSONObject = [
                "v": 1, "id": "d_1", "to": ["p_1"], "createdAt": "2026-10-11T08:00:00.000Z", "question": "Ship it?",
                "context": "", "options": c["options"]!, "source": ["machine": "devbox", "project": "starbridge", "session": "s1"],
            ]
            if let r = c["recommended"] { body["recommended"] = r }
            let ordered = try SavedDecision(from: "m_1", text: JSON.object(body).text, answeredAt: nil).body.ordered
            // By code points: Swift's == would take "é" and "e\u{301}" for one option.
            XCTAssertEqual(ordered.map { Array($0.unicodeScalars) }, c["ordered"]!.array!.map { Array($0.string!.unicodeScalars) }, c["name"]!.string!)
        }
    }
}

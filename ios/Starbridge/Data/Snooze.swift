import Foundation
import StarbridgeProtocol

/** When a snooze may end, and the times the detail offers (spec/clients.md, "Snoozed", #571). */
enum SnoozeTimes {
    static let evening = 18
    /** This evening is offered until 17:00. */
    static let eveningUntil = 17
    /** A device tells a snooze's first push from its return by it. */
    static let minimum: TimeInterval = 5 * 60
    static let maximum = TimeInterval(SNOOZE_MAX_MS / 1000)

    /** 1 hour, and This evening until 17:00. */
    static func presets(_ now: Date, _ calendar: Calendar = .current) -> [(String, Date)] {
        var out = [("1 hour", now.addingTimeInterval(3600))]
        if calendar.component(.hour, from: now) < eveningUntil, let evening = calendar.date(bySettingHour: evening, minute: 0, second: 0, of: now) {
            out.append(("This evening", evening))
        }
        return out
    }

    /** Today and the 7 days after it. */
    static func days(_ now: Date, _ calendar: Calendar = .current) -> [Date] {
        let today = calendar.startOfDay(for: now)
        return (0...7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    /** A day's first time: today an hour ahead, up to the half hour; 9:00 on another day. */
    static func start(_ day: Date, _ now: Date, _ calendar: Calendar = .current) -> Date {
        if calendar.isDate(day, inSameDayAs: now) {
            let ahead = now.addingTimeInterval(3600)
            let minute = calendar.component(.minute, from: ahead)
            let up = minute == 0 ? 0 : minute <= 30 ? 30 - minute : 60 - minute
            let start = calendar.date(bySetting: .second, value: 0, of: ahead.addingTimeInterval(TimeInterval(up * 60))) ?? ahead
            // Late in the evening that would be tomorrow: today's last half hour instead.
            if !calendar.isDate(start, inSameDayAs: day) { return calendar.date(bySettingHour: 23, minute: 30, second: 0, of: day) ?? start }
            return start
        }
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
    }

    /** "Today", "Tomorrow", then "Fri 9": a day's chip. */
    static func label(_ day: Date, _ now: Date, _ calendar: Calendar = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if calendar.isDateInTomorrow(day) { return "Tomorrow" }
        return day.formatted(.dateTime.weekday(.abbreviated).day())
    }

    static let morningHour = 9
    /** Before this hour, "tomorrow morning" is this morning: at 1:00 the owner means in 8 hours. */
    static let nightEnds = 5

    /** Tomorrow at 9:00, or this morning before 5:00. */
    static func morning(_ now: Date, _ calendar: Calendar = .current) -> Date {
        let today = calendar.startOfDay(for: now)
        let day = calendar.component(.hour, from: now) < nightEnds ? today : calendar.date(byAdding: .day, value: 1, to: today)!
        return calendar.date(bySettingHour: morningHour, minute: 0, second: 0, of: day) ?? day
    }

    static func allowed(_ until: Date, _ now: Date) -> Bool {
        until >= now.addingTimeInterval(minimum) && until <= now.addingTimeInterval(maximum)
    }
}

/** What a swipe right on a question does (#692): snooze for a set time, or ask for one. */
enum SwipeSnooze: String, CaseIterable {
    case hour, threeHours, morning, ask

    var label: String {
        switch self {
        case .hour: "Snooze 1 hour"
        case .threeHours: "Snooze 3 hours"
        case .morning: "Snooze until tomorrow morning"
        case .ask: "Ask for a time"
        }
    }

    /** When it snoozes until, from `now`; nil when it asks. */
    func until(_ now: Date, _ calendar: Calendar = .current) -> Date? {
        switch self {
        case .hour: now.addingTimeInterval(3600)
        case .threeHours: now.addingTimeInterval(3 * 3600)
        case .morning: SnoozeTimes.morning(now, calendar)
        case .ask: nil
        }
    }
}

extension Store {
    /**
     * Puts question `id` off until `until`, on every device: the snooze goes to the machine that
     * asked, so its agent hears when it would block, and to every active device, this one
     * included, so each one hides it (PROTOCOL.md, "Snoozing"). A time now or past is Back now.
     */
    func snooze(_ id: String, until: Date) async {
        do {
            try await serial { try await self.sendSnooze(id, until: until) }
        } catch is URLError {
            notice = "No connection. Not snoozed."
        } catch let e as ApiError where e.error == "already-answered" {
            notice = "Already answered on another device."
        } catch {
            notice = "Not snoozed: \(describe(error))"
        }
    }

    private func sendSnooze(_ id: String, until: Date) async throws {
        if let why = withheld() { throw Notice(message: why) }
        guard let d = decision(id), let me = saved.me else { return }
        // Fresh, as the server checks the recipients against its own: a device removed elsewhere
        // since the last read would make it refuse the snooze.
        try await syncDirectory()
        guard let dir = directory, let machine = dir.members[d.from], machine.active else {
            throw Notice(message: "the machine that asked is no longer in your devices.")
        }
        let to = [machine.member] + dir.active(.device)
        let at = now()
        let body: JSONObject = [
            "v": 1, "id": .string(newId("z_")), "decisionId": .string(id), "to": .array(to.map { .string($0.id) }),
            "until": .string(Dates.format(until)), "at": .string(at), "dir": DirectoryHead(length: dir.length, head: dir.head).json,
        ]
        let item = try Envelopes.seal(kind: .snooze, body: .object(body), signer: me.id, secretKey: try signKey, recipients: to)
        try await api().postItem(item.json)
        var s = saved
        if let i = s.decisions.firstIndex(where: { $0.id == id }) {
            s.decisions[i].snoozedUntil = Dates.format(until)
            s.decisions[i].snoozedAt = at
        }
        persist(s)
        if until > Date() { await Self.removeDelivered(about: id) }
    }
}

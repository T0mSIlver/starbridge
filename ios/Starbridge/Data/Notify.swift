import Foundation
import os
import StarbridgeProtocol
import UserNotifications

/**
 * What a pushed item's notification says, from the sealed box this iPhone opens (PROTOCOL.md,
 * "Push"). The notification service extension builds it to replace the server's placeholder; the
 * app reads the same payload to route a tap or an action.
 */
struct Shown: Equatable, Sendable {
    var title: String
    var subtitle: String
    var body: String
    /** The decision or permission the notification is about. */
    var item: String
    var category: String
    /** A `waiting` flip back to working: shown, but without a sound. */
    var quiet = false
    /** Buttons for a question: its options (at most 3), Reply, or its page. */
    var actions: [NotificationAction] = []
}

/** A notification button, as the category registers it. */
struct NotificationAction: Equatable, Sendable {
    let id: String
    let title: String
    /** Reply: a text field. */
    var text = false
    /** Opens the app (a page, or a prompt to read whole). */
    var foreground = false
    var destructive = false
    var unlock = false
}

enum Notify {
    /** The `p` beside `aps`, as JSON. */
    static func payload(_ userInfo: [AnyHashable: Any]) -> JSON? {
        guard let p = userInfo["p"], JSONSerialization.isValidJSONObject(p),
              let data = try? JSONSerialization.data(withJSONObject: p) else { return nil }
        return try? JSON.parse(String(decoding: data, as: UTF8.self))
    }

    /** The decision or permission a payload is about: its own id, or the one its `re` names. */
    static func item(_ p: JSON) -> String? {
        switch p["kind"]?.string {
        case "decision", "permission", "answered": p["id"]?.string
        default: p["re"]?.string
        }
    }

    /**
     * Whether a background push closes its item's notification: an answer from anywhere, a
     * settled notice, or a snooze as it is posted. A snooze's first push that comes near or after
     * its time, the server's `due` false, leaves it: its return showed the question or will,
     * maybe by a server clock ahead of this one (#1320).
     */
    static func closes(_ p: JSON, now: Date = Date()) -> Bool {
        switch p["kind"]?.string {
        case "answered", "settled": true
        case "snooze": !(p["due"]?.bool == false && (p["wakeAt"]?.string.flatMap(Dates.parse).map { $0 <= now.addingTimeInterval(wakeSkew) } ?? false))
        default: false
        }
    }

    /** How far the server's clock may run ahead of this iPhone's when it wakes a snooze, as Android allows. */
    static let wakeSkew: TimeInterval = 120

    /** The category of a question's own buttons. */
    static func category(_ decision: String) -> String { "d." + decision }

    /** Option buttons carry their label after this prefix; the app answers with it. */
    static let optionPrefix = "o:"

    static func header(_ source: Source) -> String { [source.machine, source.project].filter { !$0.isEmpty }.joined(separator: " · ") }

    /**
     * A question's notification: its words, then its buttons, as Android's: the page's link for one
     * answered on its page, else up to 3 options with the agent's default first, and Reply where a
     * typed answer goes (#201).
     */
    static func decision(_ d: Decision, prefix: String? = nil) -> Shown {
        let words = contextText(d.context).replacingOccurrences(of: "\n", with: " ")
        var actions: [NotificationAction] = []
        if let page = d.answerIn {
            actions.append(NotificationAction(id: "page", title: "Answer in \(page.title ?? URL(string: page.url)?.host() ?? page.url)", foreground: true))
        } else {
            actions += d.ordered.prefix(3).map { NotificationAction(id: optionPrefix + $0, title: $0) }
            if d.options.isEmpty || d.replies == true {
                actions.append(NotificationAction(id: "reply", title: d.options.isEmpty ? "Answer" : "Reply", text: true))
            }
        }
        return Shown(
            title: d.question,
            subtitle: header(d.source),
            body: [prefix, words.isEmpty ? nil : words].compactMap(\.self).joined(separator: " · "),
            item: d.id,
            category: category(d.id),
            actions: actions
        )
    }

    /**
     * A prompt's notification: what the call does, else the tool (#805), and the command. Allow
     * opens the prompt, which shows the whole input before it allows (#356); Deny answers here.
     */
    static func permission(_ p: SavedPrompt) -> Shown {
        Shown(title: p.headline, subtitle: header(p.body.source), body: p.fitsRow ? p.fullInput : visible(p.body.summary), item: p.id, category: "permission")
    }

    static let permissionActions = [
        NotificationAction(id: "allow", title: "Allow", foreground: true, unlock: true),
        NotificationAction(id: "deny", title: "Deny", destructive: true),
    ]

    /**
     * The server's placeholder, kept when the push could not be read: its text is the server's
     * own, so it keeps no button that answers a question. A prompt's Allow and Deny stay, since
     * the app reads the prompt before acting on either: Allow opens it (#356), Deny fetches it.
     */
    static func unread(_ placeholder: UNMutableNotificationContent) {
        if placeholder.categoryIdentifier != "permission" { placeholder.categoryIdentifier = "" }
    }

    /**
     * Opens a pushed item with this iPhone's keys against its pinned directory. A payload without
     * this iPhone's box, too big for a push, comes from `fetch`; so does the decision a `waiting`
     * or `snooze` item names. Nil keeps the placeholder: an item that fails its checks, a signer
     * this iPhone does not know yet, or a server holding back entries a machine has seen (#362).
     */
    static func shown(_ p: JSON, saved: Saved, secrets: Secrets, fetch: (String) async throws -> SealedItem?) async -> Shown? {
        guard let kind = p["kind"]?.string, ["decision", "permission", "waiting", "snooze"].contains(kind),
              let me = saved.me, let pk = secrets.boxPk.flatMap({ try? fromB64($0) }), let sk = secrets.boxSk.flatMap({ try? fromB64($0) }) else { return nil }
        let keys = KeyPair(publicKey: pk, secretKey: SecretKey(sk))
        let entries = saved.entries.compactMap { try? JSON.parse($0) }
        guard let dir = try? Directories.verify(entries, account: saved.account, pin: saved.pin) else { return nil }
        var heads = Heads()
        for h in saved.heads {
            if let json = try? JSON.parse(h.head), let head = try? DirectoryHead(json: json) { heads[h.id] = head }
        }
        func open(_ item: SealedItem) -> Opened? {
            guard let opened = try? Envelopes.open(item, me: me.id, keys: keys, directory: dir) else { return nil }
            _ = HeadBook.note(&heads, signer: item.from, head: opened.body.dir, entries: entries, dir: dir)
            return HeadBook.withheld(heads, dir: dir, entries: entries) == nil ? opened : nil
        }
        var item: SealedItem?
        if let box = p["box"]?.string {
            var json: JSONObject = ["v": 1, "kind": p["kind"] ?? .null, "id": p["id"] ?? .null, "from": p["from"] ?? .null]
            if let re = p["re"] { json["re"] = re }
            if let wakeAt = p["wakeAt"] { json["wakeAt"] = wakeAt }
            json["boxes"] = [["to": .string(me.id), "box": .string(box)]]
            item = try? SealedItem(json: .object(json))
        } else if let id = p["id"]?.string {
            item = try? await fetch(id)
        }
        guard let item, let opened = open(item) else { return nil }
        switch opened.body {
        case let d as Decision:
            return decision(d)
        case is Permission:
            guard let saved = try? SavedPrompt(from: item.from, text: opened.bodyText, answeredAt: nil) else { return nil }
            return permission(saved)
        case let w as Waiting:
            guard let fetched = try? await fetch(w.decisionId), let d = open(fetched)?.body as? Decision, fetched.from == item.from else { return nil }
            var shown = decision(d, prefix: w.state == "waiting" ? "Waiting for you" : nil)
            shown.quiet = w.state != "waiting"
            return shown
        case let z as Snooze:
            guard let fetched = try? await fetch(z.decisionId), let d = open(fetched)?.body as? Decision else { return nil }
            // Only the latest snooze this iPhone knows brings the question back (PROTOCOL.md,
            // "Snoozing"). An extension can't drop an alert, so an older one's return says the
            // newer time, quietly, and the app's next sync closes it.
            if let later = laterSnooze(than: z, saved.decisions.first { $0.id == z.decisionId }) {
                var shown = decision(d, prefix: "Snoozed until \(later.formatted(Date.FormatStyle(date: Calendar.current.isDateInToday(later) ? .omitted : .abbreviated, time: .shortened)))")
                shown.quiet = true
                return shown
            }
            return decision(d, prefix: "Back from snooze")
        default:
            return nil
        }
    }

    /** When a snooze newer than `z` puts the question off until, from what the app saved; nil when `z` is the latest. */
    static func laterSnooze(than z: Snooze, _ saved: SavedDecision?) -> Date? {
        guard let saved, let at = saved.snoozedAt.flatMap(Dates.parse), let mine = Dates.parse(z.at), at > mine,
              let until = saved.snoozed, until > Date() else { return nil }
        return until
    }

    /**
     * The notification service extension's work: what a push's notification says, from the keys
     * and the pinned directory the app keeps in their shared app group, with its buttons
     * registered; nil keeps the placeholder. Reads, never writes. Logs what it did, how long it
     * took and the process's memory against the 24 MB limit.
     */
    static func rewrite(_ p: JSON?) async -> Shown? {
        let log = Logger(subsystem: "dev.starbridge.ios", category: "notifications")
        let start = Date()
        guard let p, let saved = Disk.standard.load(), let secrets = try? KeychainVault().load() else {
            log.info("no payload or no saved state: kept the placeholder")
            return nil
        }
        let api = Api(server: saved.server, session: secrets.session)
        let shown = await shown(p, saved: saved, secrets: secrets) { id in try await api.item(id).item }
        if let shown, !shown.actions.isEmpty { await register(shown.category, shown.actions) }
        log.info("\(p["kind"]?.string ?? "?", privacy: .public) \(shown == nil ? "kept the placeholder" : "shown", privacy: .public) in \(Int(Date().timeIntervalSince(start) * 1000)) ms, \(footprint() / 1_048_576) MB")
        return shown
    }

    /** The process's memory as iOS counts it against an extension's limit. */
    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? info.phys_footprint : 0
    }

    // The notification center's calls live here, off the main actor, so only Sendable values cross
    // into it: Swift 6.1 refuses its non-Sendable results reaching the main actor's store.

    /** Asks once to notify: whether it may, and whether the owner refused. */
    static func authorize() async -> (granted: Bool, denied: Bool) {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        return (granted, await center.notificationSettings().authorizationStatus == .denied)
    }

    /** Closes every notification about item `id`: answered, settled, or snoozed elsewhere. */
    static func removeDelivered(about id: String) async { await removeDelivered(about: [id]) }

    /** What a notification is about, to close it: its item, or a join by digits. */
    private static func about(_ p: JSON) -> String? { p["kind"]?.string == "join" ? p["id"]?.string : item(p) }

    /** Closes every notification about any of `items`, or about any of those joins. */
    static func removeDelivered(about items: Set<String>) async {
        guard !items.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications()
            .filter { items.contains($0.request.identifier) || payload($0.request.content.userInfo).flatMap(about).map(items.contains) == true }
            .map(\.request.identifier)
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }

    /** A quiet notification about item `id`, saying how its answer ended; a tap opens it. */
    static func post(_ id: String, kind: String, title: String?, subtitle: String?, body: String) async {
        let content = UNMutableNotificationContent()
        if let title { content.title = title }
        if let subtitle { content.subtitle = subtitle }
        content.body = body
        content.interruptionLevel = .passive
        content.userInfo = ["p": ["v": 1, "kind": kind, "id": id]]
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    /** `content` rewritten as `shown` says; its category is registered already. */
    static func apply(_ shown: Shown, to content: UNMutableNotificationContent) {
        content.title = shown.title
        content.subtitle = shown.subtitle
        content.body = shown.body
        content.categoryIdentifier = shown.category
        if shown.quiet {
            content.sound = nil
            content.interruptionLevel = .passive
        }
    }

    /**
     * Adds a question's own category, keeping the others: a category's buttons are fixed when it
     * is registered, and each question's options are its own. At most 64 questions keep theirs.
     */
    static func register(_ id: String, _ actions: [NotificationAction]) async {
        let center = UNUserNotificationCenter.current()
        var categories = await center.notificationCategories()
        guard !categories.contains(where: { $0.identifier == id }) else { return }
        let questions = categories.filter { $0.identifier.hasPrefix("d.") }
        if questions.count >= 64 { categories.subtract(questions.prefix(questions.count - 63)) }
        categories.insert(category(id, actions))
        categories.insert(category("permission", permissionActions))
        center.setNotificationCategories(categories)
        // The center reads its categories again before the notification shows.
        _ = await center.notificationCategories()
    }

    static func category(_ id: String, _ actions: [NotificationAction]) -> UNNotificationCategory {
        UNNotificationCategory(identifier: id, actions: actions.map { a in
            var options: UNNotificationActionOptions = []
            if a.foreground { options.insert(.foreground) }
            if a.destructive { options.insert(.destructive) }
            if a.unlock { options.insert(.authenticationRequired) }
            return a.text
                ? UNTextInputNotificationAction(identifier: a.id, title: a.title, options: options, textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
                : UNNotificationAction(identifier: a.id, title: a.title, options: options)
        }, intentIdentifiers: [])
    }
}

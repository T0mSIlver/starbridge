import Foundation
import StarbridgeProtocol

/** How sending an answer ended. */
enum Sent: Equatable, Sendable {
    /** The server took it: this answer, or the same one sent before. */
    case answered(String)
    /** Kept in the outbox until the server can be reached. */
    case queued(String)
    /** Another device answered first. */
    case elsewhere
    /** The server refused it, with why. */
    case failed(String)
}

/** An item that opened: its signer, its body, and the body's signed text, which is what is kept. */
struct OpenedItem {
    let from: String
    let body: any ItemBody
    let text: String
}

/**
 * The inbox's side of the store, as Android's ServerStore does it: reading questions, prompts
 * and runs, and answering them. Every change runs through `serial`, so a sync's read and write
 * of a list never straddles an answer.
 */
extension Store {
    // --- What the inbox shows -------------------------------------------------------

    private func active(_ member: String) -> Bool { directory?.members[member]?.active != false }

    /** Unsent answers by decision id: tapped, or waiting in the outbox. */
    var unsent: [String: String] {
        var all = Dictionary(saved.outbox.map { ($0.decisionId, $0.answer) }, uniquingKeysWith: { $1 })
        for (id, answer) in tapped { all[id] = answer }
        return all
    }

    /** Questions still to answer here: not answered, not snoozed, not sent from this iPhone. */
    var openDecisions: [SavedDecision] {
        if withheldWhy != nil { return [] }
        let sending = unsent
        return saved.decisions.filter { $0.isOpen && $0.snoozed == nil && sending[$0.id] == nil && active($0.from) }
    }

    /** Snoozed questions, soonest back first (#571). */
    var snoozedDecisions: [SavedDecision] {
        if withheldWhy != nil { return [] }
        let sending = unsent
        return saved.decisions
            .filter { $0.snoozed != nil && sending[$0.id] == nil && active($0.from) }
            .sorted { $0.snoozed! < $1.snoozed! }
    }

    /** Answered questions, newest first, with this iPhone's unsent ones (#895). */
    var history: [SavedDecision] {
        if withheldWhy != nil { return [] }
        let sending = unsent
        return saved.decisions.filter { !$0.isOpen || sending[$0.id] != nil }.reversed()
    }

    var openPrompts: [SavedPrompt] {
        if withheldWhy != nil { return [] }
        return saved.prompts.filter { $0.isOpen && active($0.from) }
    }

    var shownRuns: [SavedRun] {
        if withheldWhy != nil { return [] }
        return saved.runs.filter { active($0.from) }
    }

    func decision(_ id: String) -> SavedDecision? { saved.decisions.first { $0.id == id } }
    func prompt(_ id: String) -> SavedPrompt? { saved.prompts.first { $0.id == id } }

    func memberName(_ id: String) -> String { directory?.members[id]?.member.name ?? id }

    // --- Syncing --------------------------------------------------------------------

    /** Reads everything new, then sends the answers waiting in the outbox. */
    func sync() async throws {
        guard phase == .ready else { return }
        try await syncDirectory()
        guard phase == .ready else { return }
        try await syncDecisions()
        try await syncPrompts()
        try await syncRuns()
        withheldWhy = withheld()
        if !saved.outbox.isEmpty { _ = try await flush() }
        // A push that would have closed them may never have come: iOS holds or drops background pushes (#1184).
        await Notify.removeDelivered(about: closedItems)
    }

    /** How far the server's clock may run ahead of this iPhone's when it wakes a snooze, as Android allows. */
    static let wakeSkew: TimeInterval = 120

    /**
     * Items whose notifications must go: questions answered, settled or snoozed for longer than
     * the wake's skew, prompts no longer open, and everything from a revoked machine, which no
     * answer reaches (#344).
     */
    var closedItems: Set<String> {
        // A snooze about to end may already have its "Back from snooze" up, by a server clock ahead of this one.
        let snoozed = { (d: SavedDecision) in d.snoozed.map { $0.timeIntervalSinceNow > Self.wakeSkew } ?? false }
        let decisions = saved.decisions.filter { !$0.isOpen || snoozed($0) || !active($0.from) }.map(\.id)
        let prompts = saved.prompts.filter { !$0.isOpen || !active($0.from) }.map(\.id)
        return Set(decisions + prompts)
    }

    /** A sync the owner asked for, pulling the list: its failure shows. */
    func refresh() async {
        do {
            try await serial { try await self.sync() }
        } catch {
            notice = describe(error)
        }
    }

    /**
     * Syncs every 10 s while the app is in front, until `stopPolling`: this step of the app has
     * no push yet. A failure shows once, not every round; being offline shows nothing, since the
     * outbox says what waits.
     */
    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var shown: String?
            // A release the server refuses stops asking until it is updated.
            while let self, !Task.isCancelled, phase == .ready, tooOld == nil {
                do {
                    try await serial { try await self.sync() }
                    shown = nil
                } catch is URLError {
                } catch is CancellationError {
                    return
                } catch {
                    let why = describe(error)
                    if why != shown { notice = why }
                    shown = why
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /** Fetches what is new and replays the whole chain; it must extend the pin. */
    func syncDirectory() async throws {
        guard let me = saved.me else { return }
        let fresh = try await api().directory(from: saved.entries.count)
        let all = try saved.entries.map(JSON.parse) + fresh
        let dir = try Directories.verify(all, account: saved.account, pin: saved.pin)
        directory = dir
        if dir.members[me.id]?.active != true {
            wipe()
            notice = "This iPhone was removed from your devices."
            return
        }
        var s = saved
        s.entries = all.map(\.text)
        s.pin = Pin(length: dir.length, head: dir.head)
        persist(s)
    }

    private var boxKeys: KeyPair? {
        guard let pk = secrets.boxPk.flatMap({ try? fromB64($0) }), let sk = secrets.boxSk.flatMap({ try? fromB64($0) }) else { return nil }
        return KeyPair(publicKey: pk, secretKey: SecretKey(sk))
    }

    private var entryJSON: [JSON] { saved.entries.compactMap { try? JSON.parse($0) } }

    private var heads: Heads {
        var h = Heads()
        for e in saved.heads {
            if let json = try? JSON.parse(e.head), let head = try? DirectoryHead(json: json) { h[e.id] = head }
        }
        return h
    }

    private func keep(_ heads: Heads) {
        var s = saved
        s.heads = heads.map { SavedHead(id: $0.0, head: $0.1.json.text) }
        persist(s)
    }

    /**
     * Opens a machine's item and keeps the directory head it signed; nil when it fails its checks,
     * being the server's or a stranger's, or while a head an active machine signed is missing from
     * this iPhone's chain (#362).
     */
    func open(_ item: SealedItem, entries: [JSON]) -> OpenedItem? {
        guard let dir = directory, let me = saved.me, let keys = boxKeys,
              let opened = try? Envelopes.open(item, me: me.id, keys: keys, directory: dir) else { return nil }
        // Machines' heads only: a device's snooze vouches for nothing here (#571).
        if item.kind.signer == .machine {
            var h = heads
            if HeadBook.note(&h, signer: item.from, head: opened.body.dir, entries: entries, dir: dir) { keep(h) }
        }
        if withheld(entries) != nil { return nil }
        return OpenedItem(from: item.from, body: opened.body, text: opened.bodyText)
    }

    /**
     * Why no machine's item counts: the server holds back entries a machine has seen. A head whose
     * member a `revoke` names says who revoked it: only the owner can tell whether they did (#813).
     */
    func withheld(_ entries: [JSON]? = nil) -> String? {
        guard let dir = directory else { return nil }
        let entries = entries ?? entryJSON
        guard let held = HeadBook.withheld(heads, dir: dir, entries: entries) else { return nil }
        let machine = memberName(held.id)
        let seen = held.by.map { "\(machine) says \(memberName($0)) has seen changes to your devices that the server is holding back." }
            ?? "The server is holding back changes to your devices that \(machine) has seen."
        guard let revoked = held.revoked else {
            return "\(seen) Nothing from your machines shows until it sends them. If this does not clear, revoke \(machine) first."
        }
        let by = memberName(revoked.by)
        return "\(seen) \(by) revoked \(memberName(revoked.id)) on \(revoked.at.prefix(10)). If you did not, the server may be hiding that \(by) was revoked. Nothing from your machines shows until this clears; if you did, tap Stop waiting."
    }

    /** The member a hold names, when the owner can end it with Stop waiting: one they revoked. */
    var heldRevoked: String? {
        guard let dir = directory else { return nil }
        return HeadBook.withheld(heads, dir: dir, entries: entryJSON)?.revoked?.id
    }

    /** The owner revoked that member themselves: forget the heads that name it, and read again. */
    func stopWaiting() async {
        guard let id = heldRevoked else { return }
        forgetHeads(of: id)
        await refresh()
    }

    /** Forgets the heads that name `id`, a member this iPhone knows the owner revoked. */
    func forgetHeads(of id: String) {
        var h = heads
        if HeadBook.forget(&h, id: id) { keep(h) }
    }

    /**
     * Keeps the heads of `items` before any counts, so the one that shows a gap holds back the
     * rest. On a hold, reads the directory once more: a machine may only have signed an entry made
     * on another device since this iPhone's last read. True while the hold remains.
     */
    private func scan(_ items: [SealedItem]) async throws -> Bool {
        let entries = entryJSON
        for item in items { _ = open(item, entries: entries) }
        if withheld(entries) == nil { return false }
        try await syncDirectory()
        if phase != .ready { return true }
        withheldWhy = withheld()
        return withheldWhy != nil
    }

    func syncDecisions() async throws {
        var cursor = saved.cursor
        var byId = Dictionary(saved.decisions.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        // How each item a settled notice closed was closed, with the time: the notice lists before
        // the decision it closed, which moved past it.
        var closings: [String: (Settled, String?)] = [:]
        // Which device's answer each machine took, whenever its notice comes (#330).
        var wins: [(String, Settled)] = []
        var waits: [(String, Waiting)] = []
        var snoozes: [Snooze] = []
        while true {
            let page = try await api().items("decision,settled,waiting,snooze", after: cursor)
            // Held: the cursor stays, so these items are read again once the hold ends.
            if try await scan(page.items.map(\.item)) { return }
            let entries = entryJSON
            for listed in page.items {
                switch listed.item.kind {
                case .waiting:
                    if let o = open(listed.item, entries: entries), let w = o.body as? Waiting { waits.append((o.from, w)) }
                    continue
                case .snooze:
                    if let o = open(listed.item, entries: entries), let z = o.body as? Snooze { snoozes.append(z) }
                    continue
                case .settled:
                    guard let o = open(listed.item, entries: entries), let n = o.body as? Settled else { continue }
                    // Keyed by machine: a notice closes only the machine's own items (#362).
                    if n.outcome == "device" { wins.append((o.from, n)) } else { closings["\(o.from)/\(n.itemId)"] = (n, listed.receivedAt) }
                    continue
                default: break
                }
                // The notice that closed it arrived in the same write, so it carries the same time;
                // a later one, after a device's answer, closed nothing.
                func settledBy(_ machine: String) -> Settled? {
                    guard let c = closings["\(machine)/\(listed.item.id)"], c.1 == listed.answeredAt else { return nil }
                    return c.0
                }
                if let known = byId[listed.item.id] {
                    // A settled notice marked it answered already, without saying how.
                    let notice = settledBy(known.from)
                    if let answeredAt = listed.answeredAt, known.answeredAt == nil || notice?.outcome != nil {
                        var d = known
                        d.answeredAt = answeredAt
                        byId[d.id] = notice.map { closed(d, by: $0) } ?? d
                    }
                    continue
                }
                guard let o = open(listed.item, entries: entries), var d = try? SavedDecision(from: o.from, text: o.text, answeredAt: listed.answeredAt) else { continue }
                d.images = SavedImage.keep(listed.item, d.body)
                byId[d.id] = settledBy(o.from).map { closed(d, by: $0) } ?? d
            }
            cursor = page.cursor
            if page.items.count < 100 { break }
        }
        // An update may list before the decision it is about, so they apply once all are read.
        for (from, w) in waits { if let d = byId[w.decisionId], let u = waited(d, from: from, w) { byId[w.decisionId] = u } }
        for z in snoozes { if let d = byId[z.decisionId], let u = snoozed(d, z) { byId[z.decisionId] = u } }
        for (from, n) in wins { if let d = byId[n.itemId], let u = won(d, from: from, n) { byId[n.itemId] = u } }
        var s = saved
        s.cursor = cursor
        s.decisions = Array(byId.values.sorted { $0.body.createdAt < $1.body.createdAt }.suffix(500))
        persist(s)
        SavedImage.prune(keeping: s.decisions)
    }

    /** `d` as its machine's notice closed it, with the agent's reason for a withdrawal (#1008). */
    private func closed(_ d: SavedDecision, by notice: Settled) -> SavedDecision {
        guard notice.outcome != nil else { return d }
        var c = d
        c.settled = notice.outcome
        c.reason = notice.outcome == "withdrawn" ? notice.reason : nil
        return c
    }

    /** `d` with the agent's waiting state, when `w` is from the machine that asked and later than the one kept. */
    private func waited(_ d: SavedDecision, from: String, _ w: Waiting) -> SavedDecision? {
        guard d.from == from, let at = Dates.parse(w.at) else { return nil }
        if let kept = d.waitingAt.flatMap(Dates.parse), kept >= at { return nil }
        var u = d
        u.waiting = w.state
        u.waitingAt = w.at
        return u
    }

    /** `d` with the owner's snooze, when it is later than the one kept; the latest wins, from any device. */
    private func snoozed(_ d: SavedDecision, _ z: Snooze) -> SavedDecision? {
        guard let at = Dates.parse(z.at) else { return nil }
        if let kept = d.snoozedAt.flatMap(Dates.parse), kept >= at { return nil }
        var u = d
        u.snoozedUntil = z.until
        u.snoozedAt = z.at
        return u
    }

    /** "Answered in" the page a question names, for a Done (#539). */
    static func doneText(_ page: DecisionLink) -> String { "Answered in \(page.title ?? URL(string: page.url)?.host() ?? page.url)" }

    /**
     * `d` answered with the other device's answer the asking machine's notice names, or nil when
     * the notice is not the asking machine's, names this iPhone, or carries no answer (#330).
     */
    private func won(_ d: SavedDecision, from: String, _ n: Settled) -> SavedDecision? {
        // A device's notice with neither choice nor text applied a Done (#539).
        guard let answer = n.choice ?? n.text ?? d.body.answerIn.map(Self.doneText) else { return nil }
        guard d.from == from, let device = n.device, device != saved.me?.id, d.answer == nil else { return nil }
        if lost.remove(d.id) != nil {
            notice = (n.choice ?? n.text) == nil ? "Marked answered on \(memberName(device))." : "Answered on \(memberName(device)): \(answer)"
        }
        var u = d
        u.answeredAt = d.answeredAt ?? now()
        u.theirAnswer = answer
        u.answeredBy = device
        return u
    }

    /**
     * Reads permission prompts and settled notices past the cursor. A prompt comes again once it
     * is answered or settled, with its time; a notice counts only from the machine that asked.
     */
    func syncPrompts() async throws {
        var cursor = saved.promptCursor
        var byId = Dictionary(saved.prompts.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        var read: [Listed] = []
        while true {
            let page = try await api().items("permission,settled", after: cursor)
            read += page.items
            cursor = page.cursor
            if page.items.count < 100 { break }
        }
        if try await scan(read.map(\.item)) { return }
        let entries = entryJSON
        // A settled prompt comes back after its notice, so prompts go first: a notice whose prompt
        // is new to this iPhone would otherwise find nothing to close.
        let ordered = read.filter { $0.item.kind == .permission } + read.filter { $0.item.kind != .permission }
        for listed in ordered {
            switch listed.item.kind {
            case .permission:
                if var known = byId[listed.item.id] {
                    if let answeredAt = listed.answeredAt, known.answeredAt == nil {
                        known.answeredAt = answeredAt
                        byId[known.id] = known
                    }
                } else if let o = open(listed.item, entries: entries), let p = try? SavedPrompt(from: o.from, text: o.text, answeredAt: listed.answeredAt) {
                    byId[p.id] = p
                }
            case .settled:
                guard let o = open(listed.item, entries: entries), let n = o.body as? Settled else { continue }
                if var p = byId[n.itemId] {
                    if p.from == o.from, p.answeredAt == nil {
                        p.answeredAt = n.at
                        byId[p.id] = p
                    }
                } else {
                    settleDecision(n.itemId, from: o.from, n)
                }
            default: continue
            }
        }
        // A week of prompts, the log's span, as the server keeps.
        let weekAgo = Date().addingTimeInterval(-7 * 86_400)
        var s = saved
        s.promptCursor = cursor
        s.prompts = byId.values.filter { Dates.parse($0.body.createdAt).map { $0 > weekAgo } ?? true }.sorted { $0.body.createdAt < $1.body.createdAt }
        persist(s)
    }

    /** A settled notice may close one of the machine's decisions: it counts as answered. */
    private func settleDecision(_ id: String, from: String, _ notice: Settled) {
        guard let i = saved.decisions.firstIndex(where: { $0.id == id && $0.from == from }) else { return }
        let d = saved.decisions[i]
        let updated: SavedDecision?
        if notice.outcome == "device" {
            updated = won(d, from: from, notice)
        } else if d.isOpen {
            var c = d
            c.answeredAt = now()
            updated = closed(c, by: notice)
        } else {
            updated = nil
        }
        guard let updated else { return }
        var s = saved
        s.decisions[i] = updated
        persist(s)
    }

    func syncRuns() async throws {
        var cursor = ""
        var fresh: [SavedRun] = []
        while true {
            let page = try await api().items("run", after: cursor)
            if try await scan(page.items.map(\.item)) { return }
            let entries = entryJSON
            for listed in page.items {
                if let o = open(listed.item, entries: entries), let r = try? SavedRun(from: o.from, text: o.text) { fresh.append(r) }
            }
            cursor = page.cursor
            if page.items.count < 100 { break }
        }
        keepRuns(fresh)
    }

    /**
     * Keeps each update newer than the one held for its run (by `at`, then the exit), and drops
     * runs with no news for a day, as the server does. A sync lists every run the server holds, so
     * a run it leaves out was dismissed on another device (#827). A run dismissed here stays out
     * until its machine posts a newer update.
     */
    private func keepRuns(_ updates: [SavedRun]) {
        func rank(_ r: SavedRun) -> (Date, Bool) { (Dates.parse(r.body.at) ?? .distantPast, r.body.exit != nil) }
        let listed = Set(updates.map(\.id))
        var held = Dictionary(saved.runs.filter { listed.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for u in updates {
            if let hidden = saved.dismissedRuns[u.id], (Dates.parse(u.body.at) ?? .distantPast) <= (Dates.parse(hidden) ?? .distantPast) { continue }
            let (at, exited) = rank(u)
            if let h = held[u.id] {
                let (hAt, hExited) = rank(h)
                if at > hAt || (at == hAt && exited && !hExited) { held[u.id] = u }
            } else {
                held[u.id] = u
            }
        }
        let dayAgo = Date().addingTimeInterval(-86_400)
        var s = saved
        s.runs = held.values.filter { $0.lastNews > dayAgo }.sorted { $0.body.startedAt < $1.body.startedAt }
        s.dismissedRuns = saved.dismissedRuns.filter { id, at in held[id] == nil && (Dates.parse(at) ?? .distantPast) > dayAgo }
        persist(s)
    }

    /** Hides a finished or lost run on every device (#827). */
    func dismissRun(_ id: String) {
        guard let r = saved.runs.first(where: { $0.id == id }) else { return }
        var s = saved
        s.runs.removeAll { $0.id == id }
        s.dismissedRuns[id] = r.body.at
        persist(s)
        Task {
            do {
                try await api().deleteItem(id)
            } catch let e as ApiError where e.status == 404 {
                // Gone already: this iPhone hides it either way.
            } catch is URLError {
                notice = "No connection. Dismissed on this iPhone only."
            } catch {
                notice = "Dismissed on this iPhone only: \(describe(error))"
            }
        }
    }

    // --- Answering ------------------------------------------------------------------

    /**
     * Answers a question at the tap: it leaves the open list at once, and comes back saying "Not
     * sent:" and why if the server refuses the answer (#895). Neither `choice` nor `text` is Done.
     */
    func answer(_ id: String, choice: String?, text: String?) {
        guard unsent[id] == nil, let d = decision(id) else { return }
        let done = choice == nil && text == nil
        tapped[id] = choice ?? text ?? d.body.answerIn.map(Self.doneText) ?? ""
        notSent[id] = nil
        Task {
            defer { tapped[id] = nil }
            do {
                let sent = try await serial({ try await self.send(id, choice: choice, text: text) })
                // Signed and kept, or moot: the typed reply has done its work. One not sent stays to edit.
                if case .failed = sent {} else { drafts[id] = nil }
                switch sent {
                case let .queued(answer):
                    notice = "No connection. \(done ? "Done" : answer) will be sent when the iPhone is back online."
                case .elsewhere:
                    let d = decision(id)
                    if let by = d?.answeredBy, let theirs = d?.theirAnswer {
                        notice = d?.body.answerIn.map(Self.doneText) == theirs ? "Marked answered on \(memberName(by))." : "Answered on \(memberName(by)): \(theirs)"
                    } else {
                        lost.insert(id)
                        notice = "Already answered on another device."
                    }
                case let .failed(why):
                    notSent[id] = why
                case .answered:
                    break
                }
            } catch let e as ApiError where e.status == 401 {
                // The answer waits in the outbox for the next sign-in.
                drafts[id] = nil
                notice = describe(e)
            } catch {
                notSent[id] = describe(error)
            }
        }
    }

    /** The Answer schema's cap on a reply's text, in code points. */
    static let replyLimit = 4000

    /** `text` cut to [replyLimit] code points. */
    static func capped(_ text: String) -> String {
        text.unicodeScalars.count <= replyLimit ? text : String(String.UnicodeScalarView(text.unicodeScalars.prefix(replyLimit)))
    }

    /**
     * Signs the answer, seals it to the machine that asked, the only recipient the server
     * accepts, and keeps it in the outbox before posting it, so an answer tapped offline is sent
     * once the server can be reached (#329). Tapping again repeats the first answer's outcome.
     */
    func send(_ id: String, choice: String?, text: String?) async throws -> Sent {
        // A notification's Reply has no field to cap it.
        let text = text.map(Self.capped)
        // Not even an answer queued before: its machine may be the one the server keeps revoked.
        if let why = withheld() { return .failed(why) }
        if let q = saved.outbox.first(where: { $0.decisionId == id }) { return try await post(q) }
        guard let d = decision(id) else { throw Notice(message: "No such question.") }
        if let answer = d.answer { return .answered(answer) }
        if d.answeredAt != nil { return .elsewhere }
        if let choice, !d.body.options.contains(where: { sameOption($0, choice) }) { throw Notice(message: "Not one of the options.") }
        let done = choice == nil && text == nil
        // Done is for a question answered on its own page that takes it (#539).
        let page = d.body.done == true ? d.body.answerIn : nil
        if done && page == nil { throw Notice(message: "Done is only for a question answered on its own page.") }
        guard let dir = directory, let machine = dir.members[d.from], machine.active else {
            throw Notice(message: "The machine that asked is no longer in your devices.")
        }
        guard let me = saved.me else { throw Notice(message: "This iPhone has no keys. Sign out and set it up again.") }
        let at = now()
        var body: JSONObject = ["v": 1, "id": .string(newId("a_")), "decisionId": .string(id), "to": .string(machine.member.id), "answeredAt": .string(at)]
        if let choice { body["choice"] = .string(choice) }
        if let text { body["text"] = .string(text) }
        if done { body["done"] = true }
        // Lets the machine notice a server holding back entries, such as a revocation.
        body["dir"] = DirectoryHead(length: dir.length, head: dir.head).json
        let item = try Envelopes.seal(kind: .answer, body: .object(body), signer: me.id, secretKey: try signKey, recipients: [machine.member])
        let q = QueuedAnswer(decisionId: id, answer: choice ?? text ?? page.map(Self.doneText) ?? "", item: item.json.text, at: at)
        var s = saved
        s.outbox.append(q)
        try save(s)
        return try await post(q)
    }

    /** Posts a queued answer and settles it, or keeps it to send later. */
    private func post(_ q: QueuedAnswer) async throws -> Sent {
        do {
            try await api().postItem(try JSON.parse(q.item))
        } catch let e as ApiError {
            if e.error == "already-answered" {
                // A retry of an answer the server took before its reply was lost finds the
                // decision answered; the server can't say by whom, so this guesses ours.
                settle(q, answer: q.mayHaveLanded ? q.answer : nil)
                return q.mayHaveLanded ? .answered(q.answer) : .elsewhere
            }
            // The session ended, or this release is refused: the answer waits for the fix.
            if e.status == 401 {
                keep(q, landed: false)
                throw e
            }
            if e.status == 426 {
                _ = describe(e)
                keep(q, landed: false)
                return .queued(q.answer)
            }
            if e.status >= 500 || e.status == 429 {
                keep(q, landed: ![502, 503, 429].contains(e.status))
                return .queued(q.answer)
            }
            var s = saved
            s.outbox.removeAll { $0.decisionId == q.decisionId }
            persist(s)
            return .failed(describe(e))
        } catch let e as URLError {
            // No route or no name: the request never left. Anything else may have reached the server.
            let neverLeft: Set<URLError.Code> = [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff]
            keep(q, landed: !neverLeft.contains(e.code))
            return .queued(q.answer)
        }
        settle(q, answer: q.answer)
        return .answered(q.answer)
    }

    private func keep(_ q: QueuedAnswer, landed: Bool) {
        guard landed, !q.mayHaveLanded, let i = saved.outbox.firstIndex(where: { $0.decisionId == q.decisionId }) else { return }
        var s = saved
        s.outbox[i].mayHaveLanded = true
        persist(s)
    }

    /** Takes the answer out of the outbox and marks its question answered, by this iPhone when `answer` is set. */
    private func settle(_ q: QueuedAnswer, answer: String?) {
        var s = saved
        s.outbox.removeAll { $0.decisionId == q.decisionId }
        if let i = s.decisions.firstIndex(where: { $0.id == q.decisionId }) {
            s.decisions[i].answeredAt = now()
            s.decisions[i].answer = answer
        }
        persist(s)
    }

    /** Sends the queued answers, oldest first; false while some still wait. */
    func flush() async throws -> Bool {
        // Kept, and tried again once the hold ends.
        if withheld() != nil { return false }
        for q in saved.outbox {
            switch try await post(q) {
            case .queued: return false
            case let .failed(why): notSent[q.decisionId] = why
            case .answered, .elsewhere: break
            }
        }
        return true
    }

    // --- Permission prompts ---------------------------------------------------------

    /**
     * Signs the answer, bound to the prompt's id and input hash, and seals it to the machine that
     * asked. A deny is for this call only; a wider allow only for a scope the prompt offered.
     */
    /** True once the server took the answer; a failure shows as a notice. */
    @discardableResult
    func answerPrompt(_ id: String, allow: Bool, scope: PermissionScope = .once, message: String? = nil) async -> Bool {
        do {
            try await serial { try await self.sendPrompt(id, allow: allow, scope: scope, message: message) }
            return true
        } catch {
            notice = describe(error)
            return false
        }
    }

    private func sendPrompt(_ id: String, allow: Bool, scope: PermissionScope, message: String?) async throws {
        if let why = withheld() { throw Notice(message: why) }
        guard let p = prompt(id) else { throw Notice(message: "No such prompt.") }
        if p.answeredAt != nil || p.answer != nil { throw Notice(message: "Already answered.") }
        let chosen = allow ? scope : .once
        if chosen != .once, !p.body.suggestions.contains(where: { $0.scope == chosen }) { throw Notice(message: "Not offered.") }
        guard let dir = directory, let machine = dir.members[p.from], machine.active else {
            throw Notice(message: "The machine that asked is no longer in your devices.")
        }
        guard let me = saved.me else { throw Notice(message: "This iPhone has no keys. Sign out and set it up again.") }
        var body: JSONObject = [
            "v": 1, "id": .string(newId("pa_")), "permissionId": .string(id), "to": .string(machine.member.id), "answeredAt": .string(now()),
            "behavior": .string(allow ? "allow" : "deny"), "scope": .string(chosen.rawValue), "inputHash": .string(p.body.inputHash),
        ]
        if !allow, let m = message?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty { body["message"] = .string(String(m.prefix(500))) }
        body["dir"] = DirectoryHead(length: dir.length, head: dir.head).json
        let item = try Envelopes.seal(kind: .permissionAnswer, body: .object(body), signer: me.id, secretKey: try signKey, recipients: [machine.member])
        do {
            try await api().postItem(item.json)
        } catch let e as ApiError where e.error == "already-answered" || e.error == "expired" {
            try? await syncPrompts()
            throw Notice(message: e.error == "expired" ? "Too late: the prompt is over." : "Already answered.")
        }
        var s = saved
        if let i = s.prompts.firstIndex(where: { $0.id == id }) {
            s.prompts[i].answeredAt = now()
            s.prompts[i].answer = allow ? "allow:\(chosen.rawValue)" : "deny"
        }
        persist(s)
    }
}

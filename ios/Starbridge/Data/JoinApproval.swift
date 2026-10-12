import Foundation
import StarbridgeProtocol

/** A browser or phone signed in to the account that asks to join by digits. */
struct JoinAsk: Equatable, Identifiable {
    let id: String
    let name: String
    /** Another device took the request: it compares digits there. */
    let elsewhere: Bool
}

/** Comparing digits for a join request, on this iPhone, as on Android. */
enum Comparison: Equatable {
    case idle
    case waiting(JoinAsk)
    /** `error`: the last approval failed on the way and can be retried. */
    case digits(JoinAsk, String, approving: Bool = false, error: String? = nil)
    case done(String)
    case failed(String)
}

/** The join being compared: its request, and the keys the digits came from. */
struct Compared {
    let join: ListedJoin
    let body: JoinRequestBody
    let keys: JoinKeys
}

/** Approving joins by digits, as Android's ServerStore does it (PROTOCOL.md, "Joining by digits"). */
extension Store {
    private func ask(_ j: ListedJoin) -> JoinAsk? {
        guard let body = try? Joins.openRequest(j.request) else { return nil }
        return JoinAsk(id: j.id, name: body.name, elsewhere: j.approver != nil && j.approver != saved.me?.id)
    }

    /** Lists the open joins while the app is in front, holding each read until one changes. */
    func watchJoins(_ on: Bool) {
        watchTask?.cancel()
        guard on else { return }
        watchTask = Task { [weak self] in
            var cursor = "0"
            // A release the server refuses stops asking until it is updated, as the sync does.
            while let self, !Task.isCancelled, tooOld == nil {
                guard phase == .ready else { return }
                do {
                    let (list, next) = try await api().joins(after: cursor, wait: 50)
                    cursor = next
                    joinViews = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
                    joinAsks = list.compactMap(ask)
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
    }

    /** Takes the request as listed and posts this iPhone's key; the digits come once the joiner reveals. */
    func compareJoin(_ id: String) {
        guard let view = joinViews[id], let ask = ask(view), let me = saved.me else { return }
        compareTask?.cancel()
        compared = nil
        comparison = .waiting(ask)
        compareTask = Task { [weak self] in
            guard let self else { return }
            do {
                let body = try Joins.openRequest(view.request)
                guard body.account == saved.account else { throw ProtocolError(.wrongAccount, body.account) }
                guard body.join == view.id else { throw ProtocolError(.badSchema, "the request names another join") }
                let eph = Joins.newKeyPair()
                var after = try await api().claimJoin(id: id, key: toB64(eph.publicKey), approver: me.id).version - 1
                while !Task.isCancelled {
                    let now: JoinView
                    do {
                        now = try await api().join(id: id, after: after, wait: 60)
                    } catch where Self.transient(error) {
                        // Giving up would lose this iPhone's key, and the server takes one.
                        if (view.expiresAt ?? .distantPast) < Date() { throw Notice(message: "The request expired.") }
                        try await Task.sleep(for: .seconds(5))
                        continue
                    }
                    after = now.version
                    if now.state == "cancelled" { throw Notice(message: "\(ask.name) cancelled the request.") }
                    guard let joinerKey = now.joinerKey else { continue }
                    let keys = try Joins.approverKeys(mine: eph, joinerKey: joinerKey, request: view.request, commitment: view.commitment)
                    // Refused meanwhile: the digits must not come back with Approve.
                    guard !Task.isCancelled else { return }
                    compared = Compared(join: view, body: body, keys: keys)
                    comparison = .digits(ask, keys.digits)
                    return
                }
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { comparison = .failed(describe(error)) }
            }
        }
    }

    /** Appends the new device's entry, then sends the approval under the compared key. */
    func approveJoin() async {
        guard let c = compared, case let .digits(ask, digits, false, _) = comparison, let me = saved.me, let account = saved.account else { return }
        comparison = .digits(ask, digits, approving: true)
        do {
            let r = c.body
            let joining = Member(id: r.id, role: .device, name: r.name, boxPk: r.boxPk, signPk: r.signPk)
            try await serial {
                try await self.syncDirectory()
                guard let dir = self.directory else { throw Notice(message: "This iPhone has no directory yet. Pull to refresh.") }
                if let present = dir.members[joining.id] {
                    if !present.active || present.member != joining { throw Notice(message: "Another member already uses this id. Ask again from the new device.") }
                } else {
                    try await self.appendEntry { Directories.addEntry($0, signer: me.id, signKey: try self.signKey, member: joining, at: self.now()) }
                }
            }
            guard let after = directory else { return }
            let body = JoinApprovalBody(join: c.join.id, account: account, length: after.length, head: after.head, approver: me.id)
            try await api().approveJoin(id: c.join.id, approval: try Joins.approval(body, keys: c.keys))
            compared = nil
            comparison = .done("\(r.name) joined.")
            await Notify.removeDelivered(about: c.join.id)
        } catch {
            // The server holds this iPhone's key for the join, so a blip keeps the digits and
            // their keys for another try; the entry appended already is reused.
            comparison = Self.transient(error) ? .digits(ask, digits, error: describe(error)) : .failed(describe(error))
        }
    }

    func refuseJoin(_ id: String) async {
        compareTask?.cancel()
        let name = joinAsks.first { $0.id == id }?.name ?? "the device"
        let differed = compared?.join.id == id
        compared = nil
        try? await api().cancelJoin(id: id)
        joinAsks.removeAll { $0.id == id }
        // The join's push is collapsed under its id: "A device wants to join" goes with it.
        await Notify.removeDelivered(about: id)
        comparison = .done(differed ? "Refused \(name): the digits differed." : "Refused \(name).")
    }

    /** A failure worth another try: offline, or the server restarting or limiting. */
    private static func transient(_ error: Error) -> Bool {
        if let e = error as? URLError { return e.code != .cancelled }
        return (error as? ApiError).map { $0.status >= 500 || $0.status == 429 } ?? false
    }

    func closeComparison() {
        compareTask?.cancel()
        compared = nil
        comparison = .idle
    }
}

import Foundation
import StarbridgeProtocol

/** Who asks to join, as the request the code's secret checked says. */
struct Joiner: Equatable {
    let name: String
    let machine: Bool
    /** The pairing code, in groups. */
    let code: String
}

/** What adding a machine or device has reached, as on Android. */
enum Approval: Equatable {
    case idle
    case checking
    case found(Joiner)
    case approving(Joiner)
    /** This iPhone shows a QR code for a new phone and waits for its request. */
    case showing(code: String, link: String)
    case done(String)
    case failed(String)
}

/** The request a code checked, waiting for Approve; the check key when a machine's QR gave one (#795). */
struct PendingPairing {
    let code: PairingCode
    let request: PairingRequestBody
    let checkKey: String?
}

/**
 * The host of a pairing link made on another server than `server`, or nil for a bare code or a
 * link to `server` (#671). A machine's QR code names its server in its query. Asked only once the
 * lookup failed: a server can answer under several names.
 */
func otherServer(_ text: String, server: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    var link = URLComponents(string: trimmed)
    if link?.scheme == "starbridge" || (link?.scheme == nil && link?.path == "starbridge-pair") {
        guard let named = link?.queryItems?.first(where: { $0.name == "server" })?.value else { return nil }
        link = URLComponents(string: named)
    }
    guard let link, link.scheme == "https" || link.scheme == "http", let host = link.host, !host.isEmpty else { return nil }
    func hostPort(_ u: URLComponents) -> String { "\(u.host?.lowercased() ?? ""):\(u.port ?? (u.scheme == "https" ? 443 : 80))" }
    if let own = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)), hostPort(own) == hostPort(link) { return nil }
    return link.port.map { "\(host):\($0)" } ?? host
}

/** Adding a machine or device, as Android's ServerStore does it: a typed or scanned code, or a QR code for a new phone. */
extension Store {
    /** Looks a code up and checks its request against the code's secret before anything shows. */
    func lookUpPairing(_ text: String) async {
        // A shown QR code's wait must not overwrite the request looked up now.
        showTask?.cancel()
        pairing = nil
        approval = .checking
        let code: PairingCode
        do {
            code = try PairingCode.fromLink(text)
        } catch {
            approval = .failed("A pairing code has 24 letters and digits.")
            return
        }
        let message: JSON
        do {
            message = try await api().pairing(code.rendezvous)
        } catch let e as ApiError where e.status == 404 {
            if let other = otherServer(text, server: saved.server) {
                approval = .failed("This code is from \(other), and this iPhone is signed in to \(URLComponents(string: saved.server)?.host ?? saved.server).")
            } else {
                approval = .failed("No pairing with this code, or it expired.")
            }
            return
        } catch {
            approval = .failed(describe(error))
            return
        }
        guard let request = try? Pairings.openRequest(message, code: code) else {
            approval = .failed("This request does not match the code. Don't approve it; make a new code.")
            return
        }
        pairing = PendingPairing(code: code, request: request, checkKey: request.role == .machine ? Pairings.checkKey(fromLink: text) : nil)
        approval = .found(Joiner(name: request.name, machine: request.role == .machine, code: code.formatted))
    }

    /** Appends the new member's entry, then sends the approval that lets it check the chain. */
    func approvePairing() async {
        guard let pending = pairing, case let .found(joiner) = approval, let me = saved.me, let account = saved.account else { return }
        approval = .approving(joiner)
        do {
            let r = pending.request
            let joining = Member(id: r.id, role: r.role, name: r.name, boxPk: r.boxPk, signPk: r.signPk)
            try await serial {
                try await self.syncDirectory()
                guard let dir = self.directory else { throw Notice(message: "This iPhone has no directory yet. Pull to refresh.") }
                // A retry after the approval failed to send finds the entry already in the chain.
                if let present = dir.members[joining.id] {
                    if !present.active || present.member != joining { throw Notice(message: "Another member already uses this id. Make a new code.") }
                } else {
                    try await self.appendEntry { Directories.addEntry($0, signer: me.id, signKey: try self.signKey, member: joining, at: self.now()) }
                }
            }
            guard let after = directory else { return }
            // From a machine's QR: proves which entry this iPhone wrote, so the machine asks no one to compare codes (#795).
            let check = try pending.checkKey.map { try Pairings.checkProof(saved.entries.map(JSON.parse), id: r.id, key: $0) }
            let body = PairingApprovalBody(rendezvous: pending.code.rendezvous, account: account, length: after.length, head: after.head, approver: me.id, check: check)
            try await api().approvePairing(pending.code.rendezvous, approval: try Pairings.approval(body, code: pending.code))
            pairing = nil
            approval = .done(r.name)
        } catch {
            approval = .failed(describe(error))
        }
    }

    func closePairing() {
        showTask?.cancel()
        pairing = nil
        approval = .idle
    }

    /** Shows a code as a QR code; the new phone scans it and posts under it, and its MAC proves it holds the code. */
    func showCode() {
        showTask?.cancel()
        pairing = nil
        let code = PairingCode.generate()
        approval = .showing(code: code.formatted, link: Pairings.link(server: saved.server, code: code))
        showTask = Task { [weak self] in
            let until = Date().addingTimeInterval(10 * 60)
            while let self, !Task.isCancelled, Date() < until {
                let message: JSON?
                do {
                    message = try await api().awaitPairing(code.rendezvous, wait: 60)
                } catch is CancellationError {
                    return
                } catch let e as ApiError {
                    if !Task.isCancelled { approval = .failed(describe(e)) }
                    return
                } catch {
                    // Offline for a moment: the code stays valid.
                    if Task.isCancelled { return }
                    try? await Task.sleep(for: .seconds(5))
                    continue
                }
                guard let message, !Task.isCancelled else { continue }
                guard let request = try? Pairings.openRequest(message, code: code) else {
                    approval = .failed("The request does not match the code. Don't approve it; show a new code.")
                    return
                }
                pairing = PendingPairing(code: code, request: request, checkKey: nil)
                approval = .found(Joiner(name: request.name, machine: request.role == .machine, code: code.formatted))
                return
            }
            if let self, !Task.isCancelled { approval = .failed("The code expired. Show a new one.") }
        }
    }

    /**
     * A machine's `starbridge://pair` link opened the app: Add a device looks its code up, once
     * this iPhone is in the account, as on Android. It is never a code to join with: the machine
     * already posted under it.
     */
    func openPairLink(_ url: URL) { pairLink = url.absoluteString }
}

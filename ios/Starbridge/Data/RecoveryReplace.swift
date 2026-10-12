import Foundation
import StarbridgeProtocol

/** This iPhone replacing the recovery key (#348): the new key stays in memory, shown, until saved. */
enum Replacing: Equatable {
    case idle
    case shown(String, saving: Bool)
    case done
}

/** The recovery key under Devices: when and on which device it was set. */
struct RecoveryInfo: Equatable {
    let setAt: Date
    let setBy: String
    let replaced: Bool
    /** A replacement made on another device since this iPhone joined, until the owner dismisses it. */
    let notice: RecoveryNotice?
}

struct RecoveryNotice: Equatable {
    let seq: Int
    let at: Date
    let by: String
}

/** The keys a replacement signs with: the new one, and the current one the owner typed. */
struct Replacement {
    let next: KeyPair
    let current: KeyPair
}

/** Replacing the recovery key, as Android's ServerStore does it (PROTOCOL.md, "Replacing the recovery key"). */
extension Store {
    var recoveryInfo: RecoveryInfo? {
        guard saved.pin != nil, let dir = directory, let mine = saved.me?.id else { return nil }
        func name(_ id: String) -> String { id == mine ? "this iPhone" : dir.members[id]?.member.name ?? id }
        // The entry that added this iPhone: a replacement before it is no news here.
        let joined = saved.entries.firstIndex { text in
            guard let env = try? SignedEnvelope(json: JSON.parse(text)), let body = try? DirectoryEntry(json: JSON.parse(env.body)) else { return false }
            switch body.op {
            case let .add(m, _), let .recover(m): return m.id == mine
            default: return false
            }
        } ?? -1
        let set = dir.recoverySet
        let at = Dates.parse(set.at) ?? .distantPast
        let fresh = set.seq > 0 && set.seq > joined && set.seq > saved.recoverySeen && set.by != mine
        return RecoveryInfo(setAt: at, setBy: name(set.by), replaced: set.seq > 0, notice: fresh ? RecoveryNotice(seq: set.seq, at: at, by: name(set.by)) : nil)
    }

    /** Makes the new key, given the current one: both sign, so neither a stolen phone nor a leaked key replaces it alone. */
    func newRecoveryKey(current typed: String) async {
        await run { [self] in
            let seed: SecretKey
            do throws(RecoveryKeyError) {
                seed = try RecoveryKeys.seed(typed)
            } catch {
                throw Notice(message: RecoveryKeyText.problem(error.reading) ?? "That is not a recovery key.")
            }
            try await serial { try await self.syncDirectory() }
            let current = RecoveryKeys.keyPair(seed)
            guard toB64(current.publicKey) == directory?.recoveryPk else { throw Notice(message: "This isn't the account's current recovery key.") }
            let nextSeed = RecoveryKeys.generateSeed()
            replacement = Replacement(next: RecoveryKeys.keyPair(nextSeed), current: current)
            replacing = .shown(RecoveryKeys.encode(nextSeed), saving: false)
        }
    }

    /** The new key reaches the directory only now, once the owner says it is saved (#328). */
    func saveRecoveryKey() async {
        guard case let .shown(key, false) = replacing, let r = replacement, let me = saved.me else { return }
        replacing = .shown(key, saving: true)
        do {
            try await serial {
                try await self.syncDirectory()
                // A recovery or a revocation removed this iPhone: the sync wiped it and said so.
                guard self.saved.me != nil, let dir = self.directory else { return }
                let nextPk = toB64(r.next.publicKey)
                // Another device replaced the key since it was typed: the confirmation could never verify.
                if dir.recoveryPk != nextPk, dir.recoveryPk != toB64(r.current.publicKey) {
                    throw Notice(message: "Another device replaced the recovery key meanwhile. Start again.")
                }
                guard dir.recoveryPk != nextPk else { return }
                // A retry after the proposal landed confirms it rather than proposing it again; one
                // another proposal replaced meanwhile can never be posted again.
                let pending = dir.pendingRecovery?.recoveryPk
                if pending != nextPk, dir.recoveryPks.contains(nextPk) {
                    throw Notice(message: "Another device proposed a new key meanwhile. Start again.")
                }
                if pending != nextPk {
                    try await self.appendEntry { Directories.recoveryEntry($0, signer: me.id, signKey: try self.signKey, recovery: r.next, at: self.now()) }
                }
                try await self.appendEntry { try Directories.recoveryConfirmEntry($0, recoveryKey: r.current.secretKey, recoveryPk: nextPk, at: self.now()) }
            }
        } catch {
            replacing = .shown(key, saving: false)
            notice = describe(error)
            return
        }
        replacement = nil
        replacing = saved.me == nil ? .idle : .done
    }

    func closeRecoveryKey() {
        // Not while a save signs with the keys: it ends in Done, or back on the key to retry.
        if case .shown(_, saving: true) = replacing { return }
        replacement = nil
        replacing = .idle
    }

    func dismissRecoveryNotice(_ seq: Int) {
        var s = saved
        s.recoverySeen = seq
        persist(s)
    }
}

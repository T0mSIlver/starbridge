// packages/protocol/src/directory.ts: replaying and writing the signed directory chain.

/** What a client remembers between fetches, so the server cannot roll the chain back. */
public struct Pin: Equatable, Sendable {
    public let length: Int
    public let head: String

    public init(length: Int, head: String) {
        self.length = length
        self.head = head
    }
}

/** The account's members after replaying a verified chain. */
public struct Directory: Sendable {
    public struct Entry: Equatable, Sendable {
        public let member: Member
        public let active: Bool
    }

    public struct RecoverySet: Equatable, Sendable {
        public let seq: Int
        public let by: String
        public let at: String
    }

    public struct PendingRecovery: Equatable, Sendable {
        public let seq: Int
        public let recoveryPk: String
        public let by: String
        public let at: String
    }

    public internal(set) var account: String
    /** The current recovery key: entry 0's, or the last confirmed replacement's. */
    public internal(set) var recoveryPk: String
    /** The entry that made `recoveryPk` current, the device that proposed it, and when. */
    public internal(set) var recoverySet: RecoverySet
    /** A proposed recovery key no confirmation has made current yet. */
    public internal(set) var pendingRecovery: PendingRecovery?
    /** Every recovery key the chain named or proposed, retired ones too: none is used again. */
    public internal(set) var recoveryPks: Set<String>
    /** By id, in the order the chain added them. */
    public internal(set) var members: [String: Entry]
    public internal(set) var memberOrder: [String]
    /** Number of entries replayed. */
    public internal(set) var length: Int
    /** Hash of the last entry's body; the next entry's `prev`. */
    public internal(set) var head: String

    /** Members in the order the chain added them. */
    public var entries: [Entry] { memberOrder.map { members[$0]! } }

    public func active(_ role: Role) -> [Member] {
        entries.filter { $0.active && $0.member.role == role }.map(\.member)
    }

    mutating func set(_ id: String, _ entry: Entry) {
        if members.updateValue(entry, forKey: id) == nil { memberOrder.append(id) }
    }
}

public enum Directories {
    /** BLAKE2b-256 of an entry's body text. */
    public static func entryHash(_ body: String) -> String { toB64(Sodium.hash(utf8(body))) }

    /**
     * Replays the directory chain and checks every rule:
     * - entry 0 adds a device, is signed by that device's own key and by the recovery key it names;
     * - each later entry is signed by an active device or by the recovery key, has the next `seq`
     *   and the previous entry's hash as `prev`;
     * - machines sign no entries; the recovery key adds a device, revoking every other member,
     *   and confirms its own replacement, nothing else;
     * - a new recovery key is proposed by a device, signed by itself, and confirmed by the
     *   current recovery key; from then on only the new key counts;
     * - ids and public keys are never reused, and revoked members stay revoked.
     */
    /// `account` is the account this client signed in to: a chain made for another is refused (#1723).
    public static func verify(_ entries: [JSON], account: String, pin: Pin? = nil, recoveryPk: String? = nil) throws -> Directory {
        if entries.isEmpty { throw ProtocolError(.badGenesis, "empty chain") }
        var dir: Directory?
        for (i, raw) in entries.enumerated() {
            let env = try SignedEnvelope(json: raw)
            if env.kind != "directory" { throw ProtocolError(.wrongKind, "entry \(i)") }
            dir = try dir.map { try apply($0, env, i) } ?? genesis(env, account: account)
        }
        let result = dir!
        if let recoveryPk, result.recoveryPk != recoveryPk { throw ProtocolError(.wrongRecoveryKey, "recovery key differs") }
        if let pin, result.length < pin.length || hashAt(entries, pin.length - 1) != pin.head {
            throw ProtocolError(.rollback, "chain does not extend the pinned one")
        }
        return result
    }

    /** Whether `entries` hold the chain `head` names: as long at least, and the same entry there. */
    public static func holds(_ entries: [JSON], _ head: Pin) -> Bool {
        head.length <= entries.count && hashAt(entries, head.length - 1) == head.head
    }

    static func hashAt(_ entries: [JSON], _ i: Int) -> String? {
        guard entries.indices.contains(i), let env = try? SignedEnvelope(json: entries[i]) else { return nil }
        return entryHash(env.body)
    }

    private static func directoryBody(_ text: String) throws -> DirectoryEntry {
        guard case .directory(let e) = try parseBody("directory", text) else { throw ProtocolError(.wrongKind) }
        return e
    }

    private static func genesis(_ env: SignedEnvelope, account: String) throws -> Directory {
        // The first entry carries its own key, so it is parsed before its signature is checked;
        // nothing in it is trusted until the check passes.
        let body = try directoryBody(env.body)
        guard case .add(let member, let recoveryPk) = body.op, body.seq == 0, body.prev == nil else {
            throw ProtocolError(.badGenesis, "must be seq 0, prev null, op add")
        }
        if member.role != .device { throw ProtocolError(.badGenesis, "must add a device") }
        if env.signer != member.id { throw ProtocolError(.badGenesis, "must be self-signed") }
        if member.id == RECOVERY { throw ProtocolError(.duplicateMember, RECOVERY) }
        guard let recoveryPk, !recoveryPk.isEmpty else { throw ProtocolError(.badGenesis, "missing recoveryPk") }
        try Envelopes.verify(env, signPk: member.signPk)
        guard let recoverySig = env.recoverySig else { throw ProtocolError(.badGenesis, "missing recoverySig") }
        try Envelopes.verify(asRecovery(env, recoverySig), signPk: recoveryPk)
        if body.account != account { throw ProtocolError(.wrongAccount, body.account) }
        return Directory(
            account: body.account,
            recoveryPk: recoveryPk,
            recoverySet: .init(seq: 0, by: member.id, at: body.at),
            pendingRecovery: nil,
            recoveryPks: [recoveryPk],
            members: [member.id: .init(member: member, active: true)],
            memberOrder: [member.id],
            length: 1,
            head: entryHash(env.body)
        )
    }

    private static func asRecovery(_ env: SignedEnvelope, _ sig: String) -> SignedEnvelope {
        SignedEnvelope(kind: env.kind, signer: RECOVERY, body: env.body, sig: sig)
    }

    private static func apply(_ dir: Directory, _ env: SignedEnvelope, _ i: Int) throws -> Directory {
        let signPk: String
        if env.signer == RECOVERY {
            signPk = dir.recoveryPk
        } else {
            guard let signer = dir.members[env.signer] else { throw ProtocolError(.unknownSigner, "entry \(i): \(env.signer)") }
            if !signer.active { throw ProtocolError(.revokedSigner, "entry \(i): \(env.signer)") }
            if signer.member.role != .device { throw ProtocolError(.signerNotAllowed, "entry \(i): machines sign no entries") }
            signPk = signer.member.signPk
        }
        try Envelopes.verify(env, signPk: signPk)
        let body = try directoryBody(env.body)
        if body.seq != i || body.prev != dir.head { throw ProtocolError(.badChain, "entry \(i): seq or prev") }
        if body.account != dir.account { throw ProtocolError(.wrongAccount, "entry \(i)") }
        if env.recoverySig != nil, body.op.name != "recovery" {
            throw ProtocolError(.badChain, "entry \(i): only entry 0 and proposals have recoverySig")
        }
        // Who signs each op: an active device, or the recovery key, which adds a device and
        // confirms its own replacement, nothing else.
        let byRecovery: Bool
        switch body.op {
        case .recover, .recoveryConfirm: byRecovery = true
        case .add, .revoke, .recovery: byRecovery = false
        }
        if (env.signer == RECOVERY) != byRecovery {
            throw ProtocolError(.signerNotAllowed, "entry \(i): a \(body.op.name) is signed by the \(byRecovery ? "recovery" : "device")")
        }

        var next = dir
        next.length = i + 1
        next.head = entryHash(env.body)
        func addDevice(_ m: Member) throws {
            if keyInUse(dir, m.signPk) || keyInUse(dir, m.boxPk) || next.members[m.id] != nil || m.id == RECOVERY {
                throw ProtocolError(.duplicateMember, "entry \(i): \(m.id)")
            }
            next.set(m.id, .init(member: m, active: true))
        }
        switch body.op {
        case .add(let member, let recoveryPk):
            if recoveryPk != nil { throw ProtocolError(.badChain, "entry \(i): only entry 0 names the recovery key") }
            try addDevice(member)
        case .recover(let member):
            if member.role != .device { throw ProtocolError(.signerNotAllowed, "entry \(i): recovery adds devices only") }
            // Every device is lost, or in someone else's hands: no member stays, machines
            // included, so a chain a server cut short of a revocation cannot bring a revoked one back.
            for id in dir.memberOrder where dir.members[id]!.active {
                next.set(id, .init(member: dir.members[id]!.member, active: false))
            }
            try addDevice(member)
            next.pendingRecovery = nil
        case .revoke(let id):
            guard let target = next.members[id], target.active else { throw ProtocolError(.unknownMember, "entry \(i): \(id)") }
            next.set(id, .init(member: target.member, active: false))
            // A revoked device's proposal goes with it.
            if dir.pendingRecovery?.by == id { next.pendingRecovery = nil }
        case .recovery(let recoveryPk):
            guard let recoverySig = env.recoverySig else { throw ProtocolError(.badRecovery, "entry \(i): missing the new key's recoverySig") }
            try Envelopes.verify(asRecovery(env, recoverySig), signPk: recoveryPk)
            if keyInUse(dir, recoveryPk) { throw ProtocolError(.badRecovery, "entry \(i): the key is already in use") }
            next.pendingRecovery = .init(seq: i, recoveryPk: recoveryPk, by: env.signer, at: body.at)
            next.recoveryPks.insert(recoveryPk)
        case .recoveryConfirm(let proposal, let recoveryPk):
            guard let pending = dir.pendingRecovery, proposal == pending.seq, recoveryPk == pending.recoveryPk else {
                throw ProtocolError(.badRecovery, "entry \(i): no pending proposal \(proposal)")
            }
            next.recoveryPk = pending.recoveryPk
            next.recoverySet = .init(seq: i, by: pending.by, at: body.at)
            next.pendingRecovery = nil
        }
        return next
    }

    /**
     * Whether `pk` is any member's key or any recovery key the chain named, current, proposed or
     * retired: keys are never reused, across members and across roles.
     */
    private static func keyInUse(_ dir: Directory, _ pk: String) -> Bool {
        dir.recoveryPks.contains(pk) || dir.members.values.contains { $0.member.signPk == pk || $0.member.boxPk == pk }
    }

    // --- Writing entries -----------------------------------------------------

    private static func withRecoverySig(_ env: SignedEnvelope, _ recoveryKey: SecretKey) -> SignedEnvelope {
        let sig = Sodium.sign(Envelopes.signatureMessage(kind: "directory", signer: RECOVERY, body: env.body), secretKey: recoveryKey)
        return SignedEnvelope(kind: env.kind, signer: env.signer, body: env.body, sig: env.sig, recoverySig: toB64(sig))
    }

    private static func entry(_ e: DirectoryEntry, signer: String, key: SecretKey) -> SignedEnvelope {
        Envelopes.sign(kind: "directory", body: e.json, signer: signer, secretKey: key)
    }

    /** Entry 0: adds `device`, signed by its own key and by the recovery key, used here once. */
    public static func genesisEntry(account: String, device: Member, signKey: SecretKey, recovery: KeyPair, at: String) -> SignedEnvelope {
        let body = DirectoryEntry(account: account, seq: 0, prev: nil, at: at, op: .add(device, recoveryPk: toB64(recovery.publicKey)))
        return withRecoverySig(entry(body, signer: device.id, key: signKey), recovery.secretKey)
    }

    private static func next(_ dir: Directory, _ at: String, _ op: DirectoryEntry.Op) -> DirectoryEntry {
        DirectoryEntry(account: dir.account, seq: dir.length, prev: dir.head, at: at, op: op)
    }

    /** `signer` is an active device's id. */
    public static func addEntry(_ dir: Directory, signer: String, signKey: SecretKey, member: Member, at: String) -> SignedEnvelope {
        entry(next(dir, at, .add(member, recoveryPk: nil)), signer: signer, key: signKey)
    }

    public static func revokeEntry(_ dir: Directory, signer: String, signKey: SecretKey, id: String, at: String) -> SignedEnvelope {
        entry(next(dir, at, .revoke(id: id)), signer: signer, key: signKey)
    }

    /** Adds `member`, a device, with the recovery private key, and revokes every other member. */
    public static func recoverEntry(_ dir: Directory, recoveryKey: SecretKey, member: Member, at: String) -> SignedEnvelope {
        entry(next(dir, at, .recover(member)), signer: RECOVERY, key: recoveryKey)
    }

    /** Proposes `recovery` as the recovery key, signed by an active device and by the new key. */
    public static func recoveryEntry(_ dir: Directory, signer: String, signKey: SecretKey, recovery: KeyPair, at: String) -> SignedEnvelope {
        let env = entry(next(dir, at, .recovery(recoveryPk: toB64(recovery.publicKey))), signer: signer, key: signKey)
        return withRecoverySig(env, recovery.secretKey)
    }

    /**
     * Confirms the pending proposal of `recoveryPk` with the current recovery private key; refuses
     * when another proposal replaced it, so the owner never confirms a key they did not make.
     */
    public static func recoveryConfirmEntry(_ dir: Directory, recoveryKey: SecretKey, recoveryPk: String, at: String) throws -> SignedEnvelope {
        guard let pending = dir.pendingRecovery, pending.recoveryPk == recoveryPk else {
            throw ProtocolError(.badRecovery, "the pending proposal is not this key")
        }
        return entry(next(dir, at, .recoveryConfirm(proposal: pending.seq, recoveryPk: recoveryPk)), signer: RECOVERY, key: recoveryKey)
    }
}

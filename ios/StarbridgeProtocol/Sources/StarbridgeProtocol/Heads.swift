// packages/protocol/src/heads.ts: detecting a withheld directory entry from the heads other
// members sign (PROTOCOL.md "Directory"). Devices sign theirs into answers and machines into
// every item, so each side can tell when the server serves it a shorter chain than a member it
// hears from has seen.

/**
 * The longest head each signer vouched for, keyed by the signer. Heads kept before #1627 may also
 * sit under "signer/by" or "signer/?", where machines before #794 put a device's head they passed
 * on: each counts as a head its signer vouched for, since only the signer signed it. Keys keep
 * insertion order.
 */
public struct Heads: Equatable, Sendable, Sequence {
    public private(set) var keys: [String] = []
    private var heads: [String: DirectoryHead] = [:]

    public init() {}

    public subscript(key: String) -> DirectoryHead? {
        get { heads[key] }
        set {
            if let newValue {
                if heads.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if heads.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var isEmpty: Bool { keys.isEmpty }

    public func makeIterator() -> AnyIterator<(String, DirectoryHead)> {
        var i = keys.makeIterator()
        return AnyIterator { i.next().map { ($0, heads[$0]!) } }
    }

    public static func == (a: Heads, b: Heads) -> Bool { a.heads == b.heads }
}

/** The `revoke` entry that names a member: who signed it, and when. */
public struct Revocation: Equatable, Sendable {
    public let id: String
    public let by: String
    public let at: String
}

/** A kept head the chain lacks, who signed it, and the `revoke` that names its signer. */
public struct Held: Equatable, Sendable {
    public let id: String
    public let head: DirectoryHead
    public let revoked: Revocation?
}

private func signerOf(_ key: String) -> String {
    String(key.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
}

/** An entry's envelope and its body's `op`, `id` and `at`, when the entry is a well-formed envelope. */
private func ops(_ entries: [JSON]) -> [(signer: String, op: String?, id: String?, at: String?)?] {
    entries.map { raw in
        guard let env = try? SignedEnvelope(json: raw) else { return nil }
        let body = (try? JSON.parse(env.body))?.object
        return (env.signer, body?["op"]?.string, body?["id"]?.string, body?["at"]?.string)
    }
}

public enum HeadBook {
    /** The `revoke` entry that names member `id`, if any; a `recover` names no one. */
    public static func revocation(of id: String, in entries: [JSON]) -> Revocation? {
        for e in ops(entries) {
            if let e, e.op == "revoke", e.id == id { return Revocation(id: id, by: e.signer, at: e.at ?? "") }
        }
        return nil
    }

    /**
     * Whether a head that member `id` signed no longer counts: the
     * chain lists `id` as revoked, and a `recover` came after any `revoke` that names it. A
     * `revoke` alone ends nothing; a `recover`, which revokes every member, ends every earlier hold.
     */
    static func removed(_ dir: Directory, _ entries: [JSON], _ id: String) -> Bool {
        guard dir.members[id]?.active == false else { return false }
        var revokedAt = -1
        var recoveredAt = -1
        for (i, e) in ops(entries).enumerated() {
            guard let e else { continue }
            if e.op == "revoke", e.id == id { revokedAt = i }
            if e.op == "recover" { recoveredAt = i }
        }
        return recoveredAt > revokedAt
    }

    /**
     * Records the head `signer` signed into an item. A shorter head never replaces a longer one
     * the chain `entries` lacks, so replaying an older item cannot lift a hold. A head that names a
     * `by`, which a machine before #794 passed on from a device, is not kept: it may lie on that
     * device's fork, and could push out the signer's own head that shows a gap (#1627). True when
     * it changed.
     */
    @discardableResult
    public static func note(_ heads: inout Heads, signer: String, head: DirectoryHead?, entries: [JSON]) -> Bool {
        guard let head, head.by == nil else { return false }
        let replace = heads[signer].map { known in
            head.length > known.length
                || (Directories.holds(entries, known.pin) && !Directories.holds(entries, head.pin))
        } ?? true
        if replace { heads[signer] = head }
        return replace
    }

    /**
     * A kept head the chain `entries` lacks: the server is holding back entries it has, or
     * serving the member that signed it another chain. It counts while its signer is listed in
     * `dir` and no `recover` removed it. A head whose signer the chain lists as revoked says so in
     * `revoked`; a head without one is returned first.
     */
    public static func withheld(_ heads: Heads, dir: Directory, entries: [JSON]) -> Held? {
        var fork: Held?
        for (key, head) in heads {
            let id = signerOf(key)
            if dir.members[id] == nil || removed(dir, entries, id) { continue }
            if Directories.holds(entries, head.pin) { continue }
            let revoked = dir.members[id]?.active == true ? nil : revocation(of: id, in: entries)
            let own = DirectoryHead(length: head.length, head: head.head)
            guard let revoked else { return Held(id: id, head: own, revoked: nil) }
            if fork == nil { fork = Held(id: id, head: own, revoked: revoked) }
        }
        return fork
    }

    /**
     * Drops every kept head member `id` signed, under any key: the owner's way out after revoking
     * a member that signed a false long head. True when any went.
     */
    @discardableResult
    public static func forget(_ heads: inout Heads, id: String) -> Bool {
        var changed = false
        for (key, _) in heads where signerOf(key) == id {
            heads[key] = nil
            changed = true
        }
        return changed
    }
}

import Foundation
import Observation
import StarbridgeProtocol

/** Where setup stands, which picks the screen. */
enum Phase: Equatable {
    case signedOut
    /** Signed in; this iPhone is not a device of the account yet. */
    case noDevice(accountExists: Bool)
    /** Waiting for the device whose QR code this iPhone scanned to approve it. */
    case joining
    /** Joining by digits: the digits once the approver's key came, and whether they matched. */
    case joiningByDigits(digits: String?, matched: Bool)
    /** The first device's recovery key, shown once until the owner says they stored it (#370). */
    case recoveryKey(String)
    case ready
}

/** A failure to show the owner, in words. */
struct Notice: Error, Equatable {
    let message: String
}

/**
 * The app's state and the setup steps, as Android's ServerStore does them: sign in, then set up
 * an empty account's first device, join the account from a device it already has, by its QR
 * code or by comparing digits, or recover it with the recovery key. Secrets go to the
 * [Vault], the rest to [Disk], each before the server hears of what they hold, so a killed app
 * resumes the same join.
 */
@MainActor
@Observable
final class Store {
    static let defaultServer = "https://starbridge.run"

    private(set) var saved: Saved
    private(set) var secrets: Secrets
    private(set) var busy = false
    var notice: String?
    /** Answers tapped and not yet in the outbox, by decision id: the card leaves at the tap (#895). */
    var tapped: [String: String] = [:]
    /** Answers the server refused, by decision id, with why: the question comes back (#895). */
    var notSent: [String: String] = [:]
    /** The server refuses this release (426): the oldest one it serves. */
    var tooOld: String?
    /** Why nothing from the machines shows: the server holds back entries a machine has seen (#362). */
    var withheldWhy: String?
    /** What a tapped notification opens over the inbox. */
    var openRequest: Sheet?
    /** Replies typed and not sent, by decision id, while the app runs (#992). */
    var drafts: [String: String] = [:]

    /** Decisions this iPhone's answer lost to another device's, until the machine says which won. */
    @ObservationIgnored var lost: Set<String> = []
    @ObservationIgnored var queue: Task<Void, Never>?
    @ObservationIgnored var pollTask: Task<Void, Never>?

    @ObservationIgnored private let vault: Vault
    @ObservationIgnored private let disk: Disk
    @ObservationIgnored private let deviceName: String
    @ObservationIgnored let http: URLSession
    @ObservationIgnored private var joinTask: Task<Void, Never>?
    @ObservationIgnored var directory: Directory?
    /** Why nothing may be stored this run: the saved state or its keys could not be read or set aside. */
    @ObservationIgnored private var locked: String?

    init(vault: Vault = KeychainVault(), disk: Disk = .standard, deviceName: String, http: URLSession = .shared) {
        self.vault = vault
        self.disk = disk
        self.deviceName = deviceName
        self.http = http
        SavedImage.directory = disk.url.deletingLastPathComponent().appendingPathComponent("images")
        let loaded = disk.loadOrMoveAside()
        if case let .saved(found) = loaded { saved = found ?? Saved(server: Self.defaultServer) } else { saved = Saved(server: Self.defaultServer) }
        do {
            secrets = try vault.load()
        } catch {
            secrets = Secrets()
            notice = "\(error)"
        }
        switch loaded {
        case .saved:
            break
        case let .aside(tag):
            // The keys describe the device the unreadable file held: they go aside with it, and the app starts signed out.
            do {
                try vault.setAside(tag)
                secrets = Secrets()
                notice = "This iPhone’s saved state couldn’t be read, so you’re signed out. Sign in again."
            } catch {
                locked = "This iPhone’s keys couldn’t be set aside with its unreadable saved state (\(error)). Restart the app."
            }
        case let .stuck(why):
            locked = "This iPhone’s saved state couldn’t be read (\(why)). Restart the app."
        }
        // Nothing is written this run, so the file and the keys stay for a launch that can read them.
        if let locked { notice = locked }
        if saved.joining != nil { waitForApproval() }
        if saved.digitJoin != nil { waitForDigitJoin() }
    }

    var phase: Phase {
        if secrets.session == nil { return .signedOut }
        if let dj = saved.digitJoin { return .joiningByDigits(digits: dj.digits, matched: dj.matched) }
        if saved.joining != nil { return .joining }
        if let seed = secrets.recoverySeed.flatMap({ try? fromB64($0) }), seed.count == 16 { return .recoveryKey(RecoveryKeys.encode(SecretKey(seed))) }
        if saved.me != nil, saved.pin != nil { return .ready }
        return .noDevice(accountExists: saved.accountExists)
    }

    var me: SavedMember? { saved.me }

    func api(_ session: String? = nil) -> Api { Api(server: saved.server, session: session ?? secrets.session, http: http) }

    /**
     * Stores the state, or throws and changes nothing: for keys and steps that must not go on
     * without being stored. A recovery key shown without its first entry stored would be confirmed
     * for an account it never belonged to.
     */
    func save(_ newSaved: Saved? = nil, _ newSecrets: Secrets? = nil) throws {
        if let locked { throw Notice(message: locked) }
        // The secrets first: a saved state naming keys the vault lacks could not resume.
        if let newSecrets { try vault.save(newSecrets) }
        // A sync that changed nothing writes nothing: the file is read by the notification extension too.
        if let newSaved, newSaved != saved {
            do {
                try disk.save(newSaved)
            } catch {
                if newSecrets != nil { try? vault.save(secrets) }
                throw error
            }
            saved = newSaved
        }
        if let newSecrets { secrets = newSecrets }
    }

    /** Stores the state; a failure shows as a notice, and the app goes on with it in memory. */
    func persist(_ newSaved: Saved? = nil, _ newSecrets: Secrets? = nil) {
        do {
            try save(newSaved, newSecrets)
        } catch {
            // What failed to store still holds for this run.
            if let newSecrets { secrets = newSecrets }
            if let newSaved { saved = newSaved }
            notice = describe(error)
        }
    }

    /** Runs one step the owner asked for, showing it busy and its failure as a notice. */
    func run(_ step: @escaping () async throws -> Void) async {
        if busy { return }
        busy = true
        notice = nil
        defer { busy = false }
        do {
            try await step()
        } catch {
            notice = describe(error)
        }
    }

    /**
     * Runs `body` after every change started before it, as Android's lock does: a sync reads the
     * saved lists, waits on the server, and writes them back, which an answer must not cut into.
     */
    func serial<T: Sendable>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = queue
        let task = Task { @MainActor in
            _ = await previous?.value
            return try await body()
        }
        queue = Task { _ = await task.result }
        return try await task.value
    }

    func describe(_ error: Error) -> String {
        if let e = error as? ApiError, e.status == 426 { tooOld = e.minimum ?? "a newer release" }
        return switch error {
        case let n as Notice: n.message
        case let e as ApiError where e.status == 401: "The server signed this iPhone out. Sign in again."
        case let e as ApiError where e.status == 429: "Too many tries. Wait a minute and try again."
        case let e as ApiError where e.status == 426: "Update Starbridge: this server needs \(e.minimum ?? "a newer release") or later."
        case let e as ApiError: "The server refused: \(e)"
        case let e as URLError where e.code == .cancelled: "Cancelled."
        case is URLError: "Can't reach \(saved.server). Check the connection and try again."
        // Another account's key, or this account's from before a replacement (#348).
        case let e as ProtocolError where e.code == .wrongRecoveryKey: "This is a recovery key, but not this account's current one."
        case let e as ProtocolError: "Something didn't check out (\(e.code.rawValue)). Try again."
        default: "\(error)"
        }
    }

    func now() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }

    func newId(_ prefix: String) -> String { prefix + toB64(Sodium.randomBytes(9)) }

    var signKey: SecretKey {
        get throws {
            guard let sk = secrets.signSk else { throw Notice(message: "This iPhone has no keys. Sign out and set it up again.") }
            return SecretKey(try fromB64(sk))
        }
    }

    // --- Signing in ---------------------------------------------------------------

    private func normalize(_ server: String) -> String {
        var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s.isEmpty ? Self.defaultServer : s
    }

    /** Starts a sign-in with GitHub on `server`: the page to open in the browser. */
    func gitHubSignInURL(server: String) -> URL? {
        var s = saved
        s.server = normalize(server)
        let verifier = SignIn.newVerifier()
        var k = secrets
        k.signInVerifier = verifier
        persist(s, k)
        return SignIn.url(server: saved.server, verifier: verifier)
    }

    /**
     * Only for the sign-in this iPhone started: without its verifier the code is worthless, and a
     * redirect with no sign-in pending is ignored. The code works once, whatever the outcome.
     */
    func receiveSignIn(_ link: URL) async {
        await run { [self] in
            guard phase == .signedOut, let verifier = secrets.signInVerifier else { return }
            // The state is the challenge this sign-in sent: a link from another sign-in leaves this one alone.
            let challenge = SignIn.challenge(verifier)
            let code: String
            switch SignIn.redirect(link) {
            case let .code(c, state) where state == challenge: code = c
            case let .denied(state) where state == challenge: throw Notice(message: "GitHub sign-in didn't finish. Sign in again.")
            default: return
            }
            var k = secrets
            k.signInVerifier = nil
            persist(nil, k)
            let session: String
            do {
                session = try await api().appSession(code: code, verifier: verifier)
            } catch let e as ApiError where e.error == "bad-code" {
                throw Notice(message: "Sign-in expired. Sign in again.")
            } catch let e as ApiError where e.error == "signups-paused" {
                throw Notice(message: "New accounts are paused on this server.")
            }
            try await afterSignIn(session)
        }
    }

    /** The browser sign-in ended without a redirect: the owner closed it. */
    func abandonSignIn() {
        var k = secrets
        k.signInVerifier = nil
        persist(nil, k)
    }

    func signInWithOwnerToken(server: String, token: String) async {
        await run { [self] in
            var s = saved
            s.server = normalize(server)
            persist(s)
            try await afterSignIn(api().ownerSignIn(token: token.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }

    /** Checks the session with the server before keeping it. */
    private func afterSignIn(_ session: String) async throws {
        let fresh = api(session)
        let me: Me
        do {
            me = try await fresh.me()
        } catch let e as ApiError where e.status == 401 {
            throw Notice(message: "Sign-in failed: the server did not accept the session.")
        }
        // This server serves this release, whatever another one said.
        tooOld = nil
        if let mine = saved.me, saved.pin != nil, saved.joining == nil, saved.digitJoin == nil, secrets.signSk != nil, me.account == saved.account {
            // Still a device: bind the new session with its signing key (PROTOCOL.md, "Auth").
            if let member = me.member, member != mine.id { throw Notice(message: "This session already belongs to another device.") }
            if me.member == nil {
                do {
                    let nonce = try await fresh.challenge()
                    let sig = Sodium.sign(Pairings.bindMessage(account: me.account, member: mine.id, nonce: nonce), secretKey: try signKey)
                    try await fresh.bind(member: mine.id, sig: toB64(sig))
                } catch let e as ApiError where e.status == 404 {
                    // No such active device, or a server without binding: the chain decides.
                    let entries = try await fresh.directory(from: 0)
                    let dir = try Directories.verify(entries, account: saved.account, pin: saved.pin)
                    if dir.members[mine.id]?.active == true { throw Notice(message: "This server cannot bind a new session to this iPhone. Update the server.") }
                    wipe()
                    throw Notice(message: "This iPhone was removed from your devices. Set it up again.")
                }
            }
            var k = secrets
            k.session = session
            persist(nil, k)
            return
        }
        if saved.pendingGenesis != nil, me.account == saved.account {
            // A first-device setup the server may already hold: keep its keys and seed to retry.
            var k = secrets
            k.session = session
            persist(nil, k)
            return
        }
        if saved.me != nil, saved.pin != nil, me.account != saved.account {
            // The server's word alone, unsigned: a hostile one could unpair the iPhone with it (#808).
            throw Notice(message: "This iPhone belongs to another account than the one you signed in to. Sign in with the account you set it up with, or sign out and remove its keys.")
        }
        // A setup that never finished: start over.
        if saved.me != nil || secrets.signSk != nil { wipe() }
        if me.member != nil { throw Notice(message: "This session already belongs to another device.") }
        let exists = !(try await fresh.directory(from: 0).isEmpty)
        var s = Saved(server: saved.server)
        s.account = me.account
        s.accountExists = exists
        persist(s, Secrets(session: session))
    }

    /** Asks the server again whether the account has a device, after one was set up elsewhere. */
    func checkAccount() async {
        await run { [self] in
            var s = saved
            s.accountExists = !(try await api().directory(from: 0).isEmpty)
            persist(s)
        }
    }

    // --- Joining ------------------------------------------------------------------

    /**
     * New keys for this iPhone, in the vault before the server hears of them. They end any
     * recovery attempt that made the ones they replace. Throws when the vault cannot keep them.
     */
    private func newMember() throws -> SavedMember {
        let box = Sodium.boxKeyPair()
        let sign = Sodium.signKeyPair()
        let name = String(deviceName.prefix(100))
        let member = SavedMember(id: newId("d_"), name: name.isEmpty ? "iPhone" : name, boxPk: toB64(box.publicKey), signPk: toB64(sign.publicKey))
        var k = secrets
        k.boxPk = member.boxPk
        k.boxSk = toB64(box.secretKey.bytes)
        k.signPk = member.signPk
        k.signSk = toB64(sign.secretKey.bytes)
        var s = saved
        s.recovering = nil
        try save(s, k)
        return member
    }

    /** The approval came: the chain up to its pin must hold this iPhone with its own keys. */
    private func finish(pin: Pin, account: String) async throws {
        guard account == saved.account else { throw ProtocolError(.wrongAccount, account) }
        guard let me = saved.me else { throw Notice(message: "This iPhone lost its keys. Start again.") }
        let entries = try await api().directory(from: 0)
        let dir = try Directories.verify(entries, account: saved.account, pin: pin)
        try Pairings.checkJoined(dir, id: me.id, role: .device, boxPk: me.boxPk, signPk: me.signPk)
        directory = dir
        var s = saved
        s.joining = nil
        s.digitJoin = nil
        s.entries = entries.map(\.text)
        s.pin = Pin(length: dir.length, head: dir.head)
        var k = secrets
        k.claim = nil
        k.joinPk = nil
        k.joinSk = nil
        persist(s, k)
    }

    /** Scanned a device's QR code: posts this iPhone's request under its code and waits. */
    func joinWithCode(_ text: String) async {
        await run { [self] in
            let code: PairingCode
            do {
                code = try PairingCode.fromLink(text)
            } catch {
                throw Notice(message: "That QR code is not a Starbridge pairing code.")
            }
            let member = try newMember()
            let claim = Pairings.newClaimSecret()
            let request = try Pairings.request(PairingRequestBody(rendezvous: code.rendezvous, role: .device, id: member.id, name: member.name, boxPk: member.boxPk, signPk: member.signPk, at: now()), code: code)
            do {
                try await api().postPairing(request, claimHash: Pairings.claimHash(claim))
            } catch let e as ApiError where e.error == "taken" || e.status == 409 {
                throw Notice(message: "That QR code is another device asking to join. On a device you already use, open Add a device and show a QR code for this iPhone.")
            }
            var s = saved
            s.me = member
            s.joining = code.formatted
            var k = secrets
            k.claim = claim
            persist(s, k)
            waitForApproval()
        }
    }

    private func waitForApproval() {
        joinTask?.cancel()
        joinTask = Task { [weak self] in
            while let self, !Task.isCancelled, let joining = saved.joining, let claim = secrets.claim {
                do {
                    let code = try PairingCode.parse(joining)
                    guard let approval = try await api().pairingResult(rendezvous: code.rendezvous, claim: claim, wait: 60) else { continue }
                    let body = try Pairings.openApproval(approval, code: code)
                    try await finish(pin: body.pin, account: body.account)
                    return
                } catch is CancellationError {
                    return
                } catch let e as URLError where e.code != .cancelled {
                    // Offline for a moment: keep waiting, the code stays valid for 10 minutes.
                    try? await Task.sleep(for: .seconds(5))
                } catch {
                    if Task.isCancelled { return }
                    let e = error as? ApiError
                    endJoin(e?.status == 404 ? "The code expired. Scan a new one." : describe(error))
                    return
                }
            }
        }
    }

    /** Asks the account's devices to let this iPhone in, by comparing digits. */
    func askDevices() async {
        await run { [self] in
            guard let account = saved.account else { return }
            let member = try newMember()
            let eph = Joins.newKeyPair()
            let id = Joins.newJoinId()
            let request = try Joins.request(JoinRequestBody(join: id, account: account, id: member.id, name: member.name, boxPk: member.boxPk, signPk: member.signPk, at: now()))
            // The key pair reaches the vault first, so a restart resumes the same join.
            var s = saved
            s.me = member
            s.digitJoin = DigitJoin(id: id, request: request)
            var k = secrets
            k.joinPk = toB64(eph.publicKey)
            k.joinSk = toB64(eph.secretKey.bytes)
            try save(s, k)
            do {
                _ = try await api().postJoin(request: request, commitment: Joins.commitment(joinerKey: eph.publicKey, request: request))
            } catch {
                endJoin(nil)
                throw error
            }
            waitForDigitJoin()
        }
    }

    /** The owner saw the same digits on both screens. */
    func confirmDigits() {
        guard var dj = saved.digitJoin, dj.digits != nil else { return }
        dj.matched = true
        var s = saved
        s.digitJoin = dj
        persist(s)
        // From the start: an approval that came before the owner confirmed is read again.
        waitForDigitJoin()
    }

    private func waitForDigitJoin() {
        joinTask?.cancel()
        joinTask = Task { [weak self] in
            var after = 0
            while let self, !Task.isCancelled, let id = saved.digitJoin?.id {
                do {
                    let view = try await api().join(id: id, after: after, wait: 60)
                    after = view.version
                    if view.state == "cancelled" { throw Notice(message: "The request was refused or cancelled. Ask again.") }
                    if try await step(view) { return }
                } catch is CancellationError {
                    return
                } catch let e as URLError where e.code != .cancelled {
                    // Offline while waiting, revealing or fetching the chain: the next step retries.
                    try? await Task.sleep(for: .seconds(5))
                    after = 0
                } catch {
                    if Task.isCancelled { return }
                    let e = error as? ApiError
                    endJoin(e?.status == 404 ? "The request expired. Ask again." : describe(error))
                    return
                }
            }
        }
    }

    /**
     * One step of a join by digits, for the state `view` shows: takes the first approver key and
     * reveals this iPhone's key, then checks the approval. True once this iPhone is in the chain.
     */
    private func step(_ view: JoinView) async throws -> Bool {
        guard var dj = saved.digitJoin, let pk = secrets.joinPk, let sk = secrets.joinSk else { return true }
        let eph = KeyPair(publicKey: try fromB64(pk), secretKey: SecretKey(try fromB64(sk)))
        if dj.approverKey == nil, let approverKey = view.approverKey {
            let keys = try Joins.joinerKeys(mine: eph, approverKey: approverKey, request: dj.request)
            dj.approverKey = approverKey
            dj.digits = keys.digits
            var s = saved
            s.digitJoin = dj
            persist(s)
        }
        // Only the first approver key counts; this iPhone answers no other.
        guard let approverKey = dj.approverKey else { return false }
        if view.joinerKey == nil, view.approverKey == approverKey {
            do {
                try await api().revealJoin(id: dj.id, key: pk)
            } catch let e as ApiError where e.error == "already-revealed" {}
        }
        guard let approval = view.approval else { return false }
        let keys = try Joins.joinerKeys(mine: eph, approverKey: approverKey, request: dj.request)
        let body = try Joins.openApproval(approval, keys: keys, join: dj.id)
        // The MAC proves only that whoever sent the approver key approved, which may be the
        // server: it counts once this iPhone's owner has seen the digits match (#355).
        if !dj.matched { return false }
        try await finish(pin: body.pin, account: body.account)
        return true
    }

    /** Drops the join in progress and the keys made for it, with what to tell the owner. */
    private func endJoin(_ message: String?) {
        var s = saved
        s.me = nil
        s.joining = nil
        s.digitJoin = nil
        var k = secrets
        for key in [\Secrets.claim, \.joinPk, \.joinSk, \.boxPk, \.boxSk, \.signPk, \.signSk] as [WritableKeyPath<Secrets, String?>] {
            k[keyPath: key] = nil
        }
        persist(s, k)
        if let message { notice = message }
    }

    func cancelJoin() async {
        joinTask?.cancel()
        joinTask = nil
        if let id = saved.digitJoin?.id { try? await api().cancelJoin(id: id) }
        endJoin(nil)
    }

    // --- The first device ------------------------------------------------------------

    /**
     * Makes the keys, the recovery seed and the signed first entry, all stored, and shows the
     * recovery key. The server sees the entry only once the owner confirms the key, as on Android
     * and the web (#370): an app deleted before that leaves no account without a device, and a
     * killed one shows the same key again.
     */
    func setUpFirstDevice() async {
        await run { [self] in
            guard saved.pendingGenesis == nil, let account = saved.account else { return }
            if !(try await api().directory(from: 0).isEmpty) {
                var s = saved
                s.accountExists = true
                persist(s)
                throw Notice(message: "This account already has devices. Join it instead.")
            }
            let member = try newMember()
            let seed = RecoveryKeys.generateSeed()
            let entry = Directories.genesisEntry(account: account, device: member.member, signKey: try signKey, recovery: RecoveryKeys.keyPair(seed), at: now())
            var s = saved
            s.me = member
            s.pin = nil
            s.pendingGenesis = entry.json.text
            var k = secrets
            k.recoverySeed = toB64(seed.bytes)
            try save(s, k)
        }
    }

    /** The owner stored the recovery key: the first entry goes to the server, and the key is forgotten. */
    func confirmRecoveryKey() async {
        await run { [self] in
            if saved.pendingGenesis != nil { try await postFirstEntry() }
            var k = secrets
            k.recoverySeed = nil
            persist(nil, k)
        }
    }

    /**
     * Posts the stored first entry, so a lost reply is retried with the same entry, and a chain
     * that already starts with it is adopted instead of refused.
     */
    private func postFirstEntry() async throws {
        guard let text = saved.pendingGenesis, let me = saved.me else { return }
        let genesis = try JSON.parse(text)
        let existing = try await api().directory(from: 0)
        if existing.isEmpty {
            try await api().append(genesis)
        } else if existing.first != genesis {
            // Another device set the account up meanwhile: this setup's key was never used.
            var s = saved
            s.me = nil
            s.pendingGenesis = nil
            s.accountExists = true
            persist(s, Secrets(session: secrets.session))
            throw Notice(message: "This account already has devices. Join it instead.")
        } else if try await api().me().member == nil {
            // The server took the entry but the session that posted it is gone: bind this one.
            let nonce = try await api().challenge()
            try await api().bind(member: me.id, sig: toB64(Sodium.sign(Pairings.bindMessage(account: saved.account ?? "", member: me.id, nonce: nonce), secretKey: try signKey)))
        }
        let dir = try Directories.verify([genesis], account: saved.account)
        directory = dir
        var s = saved
        s.entries = [text]
        s.pin = Pin(length: dir.length, head: dir.head)
        s.pendingGenesis = nil
        persist(s)
    }

    // --- Recovering -----------------------------------------------------------------

    /**
     * Adds this iPhone with the recovery key, revoking every other member: recovery means they
     * are lost, or in someone else's hands (#363).
     */
    func recover(_ key: String) async {
        await run { [self] in
            let seed: SecretKey
            do throws(RecoveryKeyError) {
                seed = try RecoveryKeys.seed(key)
            } catch {
                throw Notice(message: RecoveryKeyText.problem(error.reading) ?? "That is not a recovery key.")
            }
            let recovery = RecoveryKeys.keyPair(seed)
            let entries = try await api().directory(from: 0)
            // The chain's current recovery key must be this one, whose own signature a server cannot
            // fake; an iPhone that was a device before keeps the server from serving a shorter chain.
            let dir = try Directories.verify(entries, account: saved.account, pin: saved.pin, recoveryPk: toB64(recovery.publicKey))
            // The keys made for an earlier attempt stay until the chain holds them: when its reply
            // was lost, the server bound the session to that member, and a retry finds it there
            // (#274). Only while those keys are still this iPhone's, and the chain either lacks the
            // member or added it with the recovery key: a server could serve a fork where a device
            // it holds added the same member, leaving the other members in.
            let earlier = saved.recovering.flatMap { r -> SavedMember? in
                guard r.signPk == secrets.signPk, r.boxPk == secrets.boxPk else { return nil }
                guard let entry = dir.members[r.id] else { return r }
                return entry.active && Self.recovered(r, in: entries) ? r : nil
            }
            let member: SavedMember
            if let earlier {
                member = earlier
            } else {
                member = try newMember()
                var s = saved
                s.recovering = member
                try save(s)
            }
            var all = entries
            if dir.members[member.id]?.active != true {
                let entry = Directories.recoverEntry(dir, recoveryKey: recovery.secretKey, member: member.member, at: now()).json
                try await api().append(entry)
                all.append(entry)
            }
            let after = try Directories.verify(all, account: saved.account, pin: Pin(length: dir.length, head: dir.head))
            directory = after
            var s = saved
            s.me = member
            s.recovering = nil
            s.entries = all.map(\.text)
            s.pin = Pin(length: after.length, head: after.head)
            persist(s)
            // A session an abandoned attempt's append bound to its member cannot act as this one,
            // and the server never moves it: signing in again binds a new one to this iPhone's keys.
            if let bound = try? await api().me().member, bound != member.id {
                var k = secrets
                k.session = nil
                persist(nil, k)
                throw Notice(message: "Sign in again to finish recovering. This iPhone keeps its keys.")
            }
        }
    }

    /** Whether a `recover` entry of `entries`, which only the recovery key signs, added `member`. */
    private static func recovered(_ member: SavedMember, in entries: [JSON]) -> Bool {
        entries.contains { e in
            guard let env = try? SignedEnvelope(json: e), let body = try? JSON.parse(env.body),
                  case let .recover(m) = (try? DirectoryEntry(json: body))?.op else { return false }
            return m == member.member
        }
    }

    // --- Signing out --------------------------------------------------------------

    func wipe() {
        joinTask?.cancel()
        joinTask = nil
        pollTask?.cancel()
        pollTask = nil
        directory = nil
        tapped = [:]
        notSent = [:]
        drafts = [:]
        tooOld = nil
        withheldWhy = nil
        persist(Saved(server: saved.server), Secrets())
        try? FileManager.default.removeItem(at: SavedImage.directory)
    }

    /**
     * Deletes the account on the server, with every device, machine, item and push target, then
     * forgets it here as Sign out does. A failed delete shows why and forgets nothing (#1104).
     */
    func deleteAccount() async {
        await run { [self] in
            joinTask?.cancel()
            try await api().deleteAccount()
            wipe()
        }
    }

    /** Leaves the account: removes this iPhone from the devices unless it is the last one. */
    func signOut() async {
        joinTask?.cancel()
        busy = true
        defer { busy = false }
        if phase == .ready, let me = saved.me {
            do {
                let fetched = try await api().directory(from: saved.entries.count)
                let entries = try saved.entries.map(JSON.parse) + fetched
                let dir = try Directories.verify(entries, account: saved.account, pin: saved.pin)
                // The last device stays: removing it would leave only the recovery key.
                if dir.active(.device).count > 1 {
                    try await api().append(Directories.revokeEntry(dir, signer: me.id, signKey: signKey, id: me.id, at: now()).json)
                }
            } catch {}
        }
        if let id = saved.pushId { try? await api().unsubscribe(id) }
        if secrets.session != nil { try? await api().logout() }
        wipe()
    }
}

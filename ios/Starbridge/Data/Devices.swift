import Foundation
import StarbridgeProtocol

/** A member of the account as Devices lists it. */
struct DeviceRow: Identifiable, Equatable {
    let id: String
    let name: String
    let machine: Bool
    let addedAt: Date
    /** This iPhone. */
    let current: Bool
    /** A machine's check code, from the verified chain, which `starbridge pair` asks for (#795). */
    let check: String?
}

/** What the server says of the devices beside the chain, read when Devices opens. */
struct DeviceInfo: Equatable {
    /** What each device last said of its notifications (#943), by member id. */
    var notify: [String: String] = [:]
    /** The app each device said that from (#1019), by member id. */
    var clients: [String: String] = [:]
    /** The machines whose CLI is behind the latest release (#1050). */
    var behind: Set<String> = []
}

/** Devices' side of the store, as Android's ServerStore does it: the members, and revoking one. */
extension Store {
    /** The active members, devices first, then machines, each in the order the chain added them. */
    var devices: [DeviceRow] {
        // The pin moves with every directory change this iPhone keeps, so the list follows it.
        guard saved.pin != nil, let dir = directory else { return [] }
        var added: [String: String] = [:]
        for text in saved.entries {
            guard let env = try? SignedEnvelope(json: JSON.parse(text)), let body = try? DirectoryEntry(json: JSON.parse(env.body)) else { continue }
            switch body.op {
            case let .add(m, _), let .recover(m): added[m.id] = body.at
            default: break
            }
        }
        let entries = saved.entries.compactMap { try? JSON.parse($0) }
        let rows = dir.entries.filter(\.active).map { e in
            let m = e.member
            return DeviceRow(
                id: m.id,
                name: m.name,
                machine: m.role == .machine,
                addedAt: added[m.id].flatMap(Dates.parse) ?? .distantPast,
                current: m.id == saved.me?.id,
                check: m.role == .machine && !saved.scannedMachines.contains(m.id) ? try? Pairings.checkCode(entries, id: m.id) : nil
            )
        }
        return rows.filter { !$0.machine } + rows.filter(\.machine)
    }

    /** Reads what each device said of its notifications and which machines are behind. */
    func loadDeviceInfo() async {
        // A server without either route shows no states, or no updates.
        if let (notify, clients) = try? await api().notifications() {
            deviceInfo.notify = notify
            deviceInfo.clients = clients
        }
        if let behind = try? await api().machinesBehind() { deviceInfo.behind = behind }
    }

    /** A device or machine revoked elsewhere leaves the list: no push says so. */
    func refreshDirectory() async {
        try? await serial { try await self.syncDirectory() }
    }

    /** Revokes a device or machine: it can no longer read or answer anything. */
    func revoke(_ id: String) async {
        await run { [self] in
            guard let me = saved.me else { return }
            if id == me.id { throw Notice(message: "Sign out to remove this iPhone.") }
            try await serial {
                try await self.syncDirectory()
                try await self.appendEntry { Directories.revokeEntry($0, signer: me.id, signKey: try self.signKey, id: id, at: self.now()) }
                // This iPhone signed the revocation, so it is no fork: a head the member forged ends with it (#813).
                self.forgetHeads(of: id)
            }
            // The revocation may end a hold that named this member (#813).
            withheldWhy = withheld()
            // Its questions and prompts leave the inbox, and their notifications close (#344).
            await Notify.removeDelivered(about: closedItems)
        }
    }

    /** Appends the entry `make` signs on the current chain, and moves the pin to it. */
    func appendEntry(_ make: (Directory) throws -> SignedEnvelope) async throws {
        guard let dir = directory else { throw Notice(message: "This iPhone has no directory yet. Pull to refresh.") }
        let entry = try make(dir).json
        try await api().append(entry)
        let all = try saved.entries.map(JSON.parse) + [entry]
        let after = try Directories.verify(all, account: saved.account, pin: saved.pin)
        directory = after
        var s = saved
        s.entries = all.map(\.text)
        s.pin = Pin(length: after.length, head: after.head)
        persist(s)
    }
}

/** A member's symbol (#1019): a server for a machine; a device's app, as it said with its notifications. */
func memberSymbol(_ row: DeviceRow, client: String?) -> String {
    if row.machine { return "server.rack" }
    if row.current || client == "android" || client == "ios" { return "iphone" }
    return switch client {
    case "web": "globe"
    case "desktop": "laptopcomputer"
    default: "macbook.and.iphone"
    }
}

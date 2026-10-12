import StarbridgeProtocol
import SwiftUI

/** The account's devices and machines, each with Revoke, as on Android (spec/clients.md, "Devices"). */
struct DevicesView: View {
    let store: Store
    @State private var revoking: DeviceRow?
    @State private var scanning = false
    @State private var replacing = false
    /** Add a device, with the code the scanner read, if any. */
    @State private var adding: AddDevice?

    struct AddDevice: Hashable {
        var lookUp: String?
    }

    var body: some View {
        let rows = store.devices
        // A name two rows share, such as a machine paired again, adds the time to tell them apart (#287).
        let twins = Set(Dictionary(grouping: rows, by: \.name).filter { $0.value.count > 1 }.keys)
        List {
            Section {
                ForEach(rows) { row in
                    // A machine's check code goes once its window ends, with the screen left open (#939).
                    TimelineView(.everyMinute) { time in
                        MemberRow(row: row, twin: twins.contains(row.name), info: store.deviceInfo, now: time.date) { revoking = row }
                    }
                }
            }
            if let recovery = store.recoveryInfo {
                Section {
                    RecoveryRow(recovery: recovery) { replacing = true }
                }
            }
            Section {
                Button {
                    // A phone that cannot scan opens Add a device instead, to type the code.
                    Task { if await QRScanner.whyNot(typing: true) == nil { scanning = true } else { adding = AddDevice() } }
                } label: {
                    Label("Scan a QR code", systemImage: "qrcode.viewfinder")
                }
                Button("Other ways to add a device") { adding = AddDevice() }
            }
            .listRowBackground(Tokens.Colors.surface.color)
        }
        .navigationDestination(isPresented: $replacing) { RecoveryReplaceView(store: store) }
        .navigationDestination(item: $adding) { AddDeviceView(store: store, lookUp: $0.lookUp) }
        .sheet(isPresented: $scanning) {
            QRScanner { text in
                scanning = false
                adding = AddDevice(lookUp: text)
            }
            .ignoresSafeArea()
        }
        .scrollContentBackground(.hidden)
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        .navigationTitle("Devices")
        .refreshable {
            await store.refreshDirectory()
            await store.loadDeviceInfo()
        }
        // A device or machine revoked elsewhere leaves the list while it is open: no push says so.
        .task {
            await store.loadDeviceInfo()
            while !Task.isCancelled {
                await store.refreshDirectory()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .alert(
            "Revoke \(revoking?.name ?? "")?",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            presenting: revoking
        ) { row in
            Button("Revoke", role: .destructive) { Task { await store.revoke(row.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("It can no longer read or answer anything. This can't be undone.")
        }
    }
}

/**
 * A member: its symbol, name and when it joined; Revoke is a plain text button. A machine shows
 * its check code while `starbridge pair` waits for the owner to compare it (#939).
 */
private struct MemberRow: View {
    let row: DeviceRow
    let twin: Bool
    let info: DeviceInfo
    let now: Date
    let onRevoke: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Spacing.s4) {
            Image(systemName: memberSymbol(row, client: info.clients[row.id]))
                .font(.system(size: 20))
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).type(Tokens.Typography.body)
                Text(subtitle).type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color)
                if let check = row.check, now.timeIntervalSince(row.addedAt) * 1000 < Double(Pairings.checkConfirmMs) {
                    Text("Same code as on the machine? \(Text(check).font(.system(.footnote, design: .monospaced)))")
                        .type(Tokens.Typography.small)
                        .foregroundStyle(Tokens.Colors.fg2.color)
                }
                if let state = info.notify[row.id], let label = Self.notifyLabels[state] {
                    Text(label)
                        .type(Tokens.Typography.small)
                        .foregroundStyle((state == "blocked" ? Tokens.Colors.bad : Tokens.Colors.fg2).color)
                }
                if info.behind.contains(row.id) {
                    Text("Update available").type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !row.current {
                Button("Revoke", action: onRevoke)
                    .buttonStyle(.borderless)
                    .type(Tokens.Typography.label)
                    .foregroundStyle(Tokens.Colors.fg.color)
                    .accessibilityLabel("Revoke \(row.name)")
            }
        }
        .padding(.vertical, Tokens.Spacing.s1)
        .listRowBackground(Tokens.Colors.surface.color)
    }

    private static let notifyLabels = ["on": "Notifications on", "off": "Notifications off", "blocked": "Notifications blocked"]

    private var subtitle: String {
        let day = row.addedAt.formatted(.dateTime.month(.abbreviated).day())
        let added = "added \(day)" + (twin ? ", \(row.addedAt.formatted(date: .omitted, time: .shortened))" : "")
        if row.current { return "This iPhone" }
        if row.machine { return "Machine · \(added)" }
        return added.prefix(1).uppercased() + added.dropFirst()
    }
}

/** The recovery key under the members: when and on which device it was set, with Replace (#348). */
private struct RecoveryRow: View {
    let recovery: RecoveryInfo
    let onReplace: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Spacing.s4) {
            Image(systemName: "key").font(.system(size: 20)).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Recovery key").type(Tokens.Typography.body)
                Text("\(recovery.replaced ? "Replaced" : "Set") \(recovery.setAt.formatted(.dateTime.month(.abbreviated).day())), \(recovery.setAt.formatted(date: .omitted, time: .shortened)) on \(recovery.setBy)")
                    .type(Tokens.Typography.small)
                    .foregroundStyle(Tokens.Colors.fg2.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Replace", action: onReplace)
                .buttonStyle(.borderless)
                .type(Tokens.Typography.label)
                .foregroundStyle(Tokens.Colors.fg.color)
                .accessibilityLabel("Replace the recovery key")
        }
        .padding(.vertical, Tokens.Spacing.s1)
        .listRowBackground(Tokens.Colors.surface.color)
    }
}

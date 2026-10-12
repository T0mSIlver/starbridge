import SwiftUI

/** The tabs, as Android's (#1233): Inbox, with how many questions need the owner, and Settings. */
struct MainTabs: View {
    let store: Store
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = Tab.inbox

    enum Tab: Hashable { case inbox, settings }

    var body: some View {
        let needYou = store.openDecisions.count
        TabView(selection: $tab) {
            InboxView(store: store)
                .tabItem { Label("Inbox", systemImage: "tray").accessibilityValue(needYou > 0 ? "\(needYou) need you" : "") }
                // Hidden at 0.
                .badge(needYou)
                .tag(Tab.inbox)
            SettingsView(store: store)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .task {
            store.startPolling()
            await store.enableNotifications()
        }
        // A tapped notification opens its item over the inbox.
        .onChange(of: store.openRequest, initial: true) { _, request in
            if request != nil { tab = .inbox }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.startPolling() } else { store.stopPolling() }
        }
    }
}

/** Settings, in Android's order (spec/android.md); what this iPhone keeps stays on it. */
struct SettingsView: View {
    let store: Store
    /** Answer buttons on cards: Always, When the agent waits, or Never (#138). */
    @AppStorage("answerButtons") private var answerButtons = AnswerButtons.always
    @State private var signingOut = false
    @State private var deleting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Answer buttons on cards") {
                    Picker("Answer buttons on cards", selection: $answerButtons) {
                        ForEach(AnswerButtons.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                .listRowBackground(Tokens.Colors.surface.color)

                Section("Devices") {
                    NavigationLink { DevicesView(store: store) } label: {
                        LabeledContent("Devices and machines", value: "\(store.devices.count)")
                    }
                }
                .listRowBackground(Tokens.Colors.surface.color)

                Section("Account") {
                    LabeledContent("Server", value: store.saved.server)
                    LabeledContent("This iPhone", value: store.me?.name ?? "")
                    Link(destination: SettingsView.guide) {
                        Label("Agent instructions", systemImage: "arrow.up.right.square")
                    }
                    Button("Sign out") { signingOut = true }
                    Button("Delete account", role: .destructive) { deleting = true }
                }
                .listRowBackground(Tokens.Colors.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Tokens.Colors.bg.color.ignoresSafeArea())
            .navigationTitle("Settings")
        }
        .alert("Sign out?", isPresented: $signingOut) {
            Button("Sign out", role: .destructive) { Task { await store.signOut() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPhone forgets its keys and leaves your devices. If it is your only device, you need the recovery key to set up another.")
        }
        .deleteAccount(store: store, isPresented: $deleting, text: DeleteAccount.paired)
    }

    /** How to tell agents to ask through Starbridge. */
    static let guide = URL(string: "https://starbridge.run/docs/tell-your-agents")!
}

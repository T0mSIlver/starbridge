import SwiftUI

/**
 * The tabs, as Android's (#1233): Inbox, with how many questions need the owner, Quotas once a
 * machine sends them (#914), and Settings.
 */
struct MainTabs: View {
    let store: Store
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = Tab.inbox

    enum Tab: Hashable { case inbox, quotas, settings }

    var body: some View {
        let needYou = store.openDecisions.count
        TabView(selection: $tab) {
            InboxView(store: store)
                .tabItem { Label("Inbox", systemImage: "tray").accessibilityValue(needYou > 0 ? "\(needYou) need you" : "") }
                // Hidden at 0.
                .badge(needYou)
                .tag(Tab.inbox)
            if store.quotasHeld || tab == .quotas {
                QuotasView(store: store)
                    .tabItem { Label("Quotas", systemImage: "gauge.with.dots.needle.33percent") }
                    .tag(Tab.quotas)
            }
            SettingsView(store: store)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .task {
            store.startPolling()
            store.foreground(scenePhase == .active)
            store.watchJoins(scenePhase == .active)
            await store.enableNotifications()
        }
        .joinPrompt(store: store)
        // Presence (#848): a touch anywhere, or a key typed into a field, counts; never which.
        .background(TouchHook { store.touched() })
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidChangeNotification)) { _ in store.touched() }
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidChangeNotification)) { _ in store.touched() }
        // A pairing link opens Add a device with its code looked up (#611).
        .sheet(item: Binding(get: { store.pairLink.map(PairLink.init) }, set: { store.pairLink = $0?.id })) { link in
            NavigationStack {
                AddDeviceView(store: store, lookUp: link.id)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { store.pairLink = nil } } }
            }
        }
        // A tapped notification opens its item over the inbox.
        .onChange(of: store.openRequest, initial: true) { _, request in
            if request != nil { tab = .inbox }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.startPolling() } else { store.stopPolling() }
            store.foreground(phase == .active)
            store.watchJoins(phase == .active)
        }
    }
}

/** Puts a [TouchWatcher] on the window this view lands in, once. */
private struct TouchHook: UIViewRepresentable {
    let onTouch: () -> Void

    func makeUIView(context: Context) -> HookView {
        let view = HookView()
        view.onTouch = onTouch
        return view
    }

    func updateUIView(_ view: HookView, context: Context) { view.onTouch = onTouch }

    final class HookView: UIView {
        var onTouch: () -> Void = {}
        private let watcher = TouchWatcher()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, watcher.view !== window else { return }
            watcher.cancelsTouchesInView = false
            watcher.delaysTouchesBegan = false
            watcher.onTouch = { [weak self] in self?.onTouch() }
            window.addGestureRecognizer(watcher)
        }
    }
}

/** Settings, in Android's order (spec/android.md); what this iPhone keeps stays on it. */
struct SettingsView: View {
    let store: Store
    /** Answer buttons on cards: Always, When the agent waits, or Never (#138). */
    @AppStorage("answerButtons") private var answerButtons = AnswerButtons.always
    /** What a swipe right on a question does (#692). */
    @AppStorage("swipeSnooze") private var swipe = SwipeSnooze.hour
    @State private var signingOut = false
    @State private var deleting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Link(destination: URL(string: UIApplication.openNotificationSettingsURLString)!) {
                        Label("Notification settings", systemImage: "arrow.up.right.square")
                    }
                    if let hold = store.pushHold {
                        VStack(alignment: .leading, spacing: Tokens.Spacing.s2) {
                            Text("Quiet other devices while you’re at a screen")
                            Text("Then notify them this long after you leave")
                                .type(Tokens.Typography.small)
                                .foregroundStyle(Tokens.Colors.fg2.color)
                            Picker("Quiet other devices while you’re at a screen", selection: Binding(get: { hold }, set: { new in Task { await store.setPushHold(new) } })) {
                                ForEach(Beacon.holdChoices, id: \.self) { Text(Beacon.holdLabel($0)).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        .padding(.vertical, Tokens.Spacing.s1)
                    }
                } header: {
                    Text("Notifications")
                }
                .listRowBackground(Tokens.Colors.surface.color)
                .task { await store.loadPushHold() }
                if store.quotasHeld { QuotaSections(store: store) }

                Section("Answer buttons on cards") {
                    Picker("Answer buttons on cards", selection: $answerButtons) {
                        ForEach(AnswerButtons.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                .listRowBackground(Tokens.Colors.surface.color)

                // A swipe right on a question (#692): at once for a set time, or the times to pick from.
                Section("Swipe right on a question") {
                    Picker("Swipe right on a question", selection: $swipe) {
                        ForEach(SwipeSnooze.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                .listRowBackground(Tokens.Colors.surface.color)

                Section("Devices") {
                    NavigationLink { DevicesView(store: store) } label: {
                        LabeledContent("Devices and machines", value: "\(store.devices.count)")
                    }
                    NavigationLink { AddDeviceView(store: store) } label: {
                        Label("Add a device", systemImage: "qrcode")
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

/**
 * Settings → Quotas, as Android's (#930): how bars read, Alerts, then Order, a page with
 * Running out first and the providers, each with its handle and eye.
 */
private struct QuotaSections: View {
    @Bindable var store: Store

    var body: some View {
        Section("Quotas") {
            Picker("Bar shows", selection: $store.quotaSettings.showUsed) {
                Text("Used").tag(true)
                Text("Left").tag(false)
            }
            Picker("Reset times", selection: $store.quotaSettings.absoluteResets) {
                Text("Resets in 2 h").tag(false)
                Text("Resets 14:20").tag(true)
            }
            Picker("Workday ticks on weekly bars", selection: $store.quotaSettings.workDays) {
                Text("Off").tag(Int?.none)
                Text("4").tag(Int?.some(4))
                Text("5").tag(Int?.some(5))
                Text("7 days").tag(Int?.some(7))
            }
            NavigationLink("Alerts") { QuotaAlertsView(store: store) }
            NavigationLink("Order") { QuotaOrderView(store: store) }
        }
        .listRowBackground(Tokens.Colors.surface.color)
    }
}

/** Running out first, then each provider in its order, with a handle to drag and an eye that shows or hides it. */
struct QuotaOrderView: View {
    @Bindable var store: Store

    var body: some View {
        let providers = store.quotaSettings.providers(store.quotaWindows)
        List {
            Section {
                Toggle("Running out first", isOn: $store.quotaSettings.runningOutFirst)
            }
            .listRowBackground(Tokens.Colors.surface.color)
            Section("Providers") {
                ForEach(providers, id: \.self) { p in
                    let shown = !store.quotaSettings.hidden.contains(p)
                    HStack {
                        Text(p).foregroundStyle(shown ? Tokens.Colors.fg.color : Tokens.Colors.fg3.color)
                        Spacer()
                        Button {
                            var s = store.quotaSettings
                            s.hidden = shown ? s.hidden + [p] : s.hidden.filter { $0 != p }
                            store.quotaSettings = s
                        } label: {
                            Image(systemName: shown ? "eye" : "eye.slash")
                                .foregroundStyle(shown ? Tokens.Colors.fg2.color : Tokens.Colors.fg3.color)
                                .frame(minWidth: 44, minHeight: 44)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Show \(p)")
                        .accessibilityValue(shown ? "On" : "Off")
                    }
                }
                .onMove { from, to in
                    var order = providers
                    order.move(fromOffsets: from, toOffset: to)
                    store.quotaSettings.order = order
                }
            }
            .listRowBackground(Tokens.Colors.surface.color)
        }
        .environment(\.editMode, .constant(.active))
        .scrollContentBackground(.hidden)
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        .navigationTitle("Order")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PairLink: Identifiable {
    let id: String
}

/**
 * Settings → Quotas → Alerts (#930): one card, the column names once on top, then a row per
 * window of the providers shown, a checkbox per alert. A window with no box ticked is off.
 */
struct QuotaAlertsView: View {
    @Bindable var store: Store
    @ScaledMetric(relativeTo: .caption) private var column: CGFloat = 56

    var body: some View {
        let windows = store.quotaWindows
        let settings = store.quotaSettings
        var seen = Set<String>()
        let all = windows.filter { seen.insert("\($0.provider)/\($0.windowId)").inserted }
        let shown = settings.providers(windows).filter { !settings.hidden.contains($0) }
        List {
            Section {
                HStack(alignment: .bottom, spacing: 0) {
                    Spacer(minLength: 0)
                    ForEach(QuotaAlerts.choices, id: \.0) { _, label in
                        Text(label)
                            .type(Tokens.Typography.caption)
                            .foregroundStyle(Tokens.Colors.fg2.color)
                            .multilineTextAlignment(.center)
                            .frame(width: column)
                    }
                }
                .accessibilityHidden(true)
                if shown.isEmpty {
                    Text("No quota windows shown").foregroundStyle(Tokens.Colors.fg2.color)
                }
                ForEach(shown, id: \.self) { p in
                    ForEach(all.filter { $0.provider == p }, id: \.windowId) { w in
                        row(w, all: all.map { ($0.provider, $0.windowId) }, settings: settings)
                    }
                }
            }
            .listRowBackground(Tokens.Colors.surface.color)
        }
        .scrollContentBackground(.hidden)
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        .navigationTitle("Alerts")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ w: QuotaRow, all: [(String, String)], settings: QuotaSettings) -> some View {
        let picked = settings.alerts.choices(provider: w.provider, window: w.windowId, minutes: w.windowMinutes)
        return HStack(spacing: 0) {
            Text("\(w.provider) \(w.window)").frame(maxWidth: .infinity, alignment: .leading)
            ForEach(QuotaAlerts.choices, id: \.0) { kind, label in
                let on = picked.contains(kind)
                Button {
                    let next = QuotaAlerts.choices.map(\.0).filter { ($0 == kind && !on) || ($0 != kind && picked.contains($0)) }
                    store.quotaSettings.alerts = settings.alerts.with(provider: w.provider, window: w.windowId, all: all, picked: next)
                } label: {
                    Image(systemName: on ? "checkmark.square.fill" : "square")
                        .font(.title3)
                        .foregroundStyle(on ? Tokens.Colors.fg.color : Tokens.Colors.fg3.color)
                        .frame(width: column, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(w.provider) \(w.window): \(label)")
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

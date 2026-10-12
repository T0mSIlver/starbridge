import SwiftUI

@main
struct StarbridgeApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            Root(store: delegate.store)
                .background(Tokens.Colors.bg.color.ignoresSafeArea())
                .tint(Tokens.Colors.fg.color)
                // A sign-in finished in Safari rather than in the app's sign-in sheet.
                .onOpenURL { url in Task { await delegate.store.receiveSignIn(url) } }
        }
    }
}

/** The update screen when the server refuses this release, else the inbox once set up, else setup. */
struct Root: View {
    let store: Store

    var body: some View {
        Group {
            // Signed out, the owner can still sign in elsewhere or to another server.
            if let minimum = store.tooOld, store.phase != .signedOut {
                UpdateView(minimum: minimum)
            } else if store.phase == .ready {
                MainTabs(store: store)
            } else {
                SetupView(store: store)
            }
        }
        .alert("Starbridge", isPresented: showsNotice) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.notice ?? "")
        }
    }

    private var showsNotice: Binding<Bool> {
        Binding(get: { store.notice != nil && (store.tooOld == nil || store.phase == .signedOut) }, set: { if !$0 { store.notice = nil } })
    }
}

/** The server needs a newer release (426 `client-too-old`, #468); answers wait in the outbox. */
private struct UpdateView: View {
    let minimum: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
            Text("Update Starbridge").type(Tokens.Typography.title)
            Text("Your server needs Starbridge \(minimum) or later. This iPhone has \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "an older one"). Answers you gave are kept and sent once it is updated.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
            Spacer()
        }
        .padding(.horizontal, Tokens.Spacing.s4)
        .padding(.top, Tokens.Spacing.s12)
        .foregroundStyle(Tokens.Colors.fg.color)
    }
}

import SwiftUI

/**
 * Replacing the recovery key (#348), with the current one: then the new key to write down, which
 * reaches the directory only once saved, as on Android.
 */
struct RecoveryReplaceView: View {
    let store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var stored = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
                switch store.replacing {
                case let .shown(key, saving): shown(key, saving: saving)
                case .done: done
                case .idle: ask
                }
            }
            .padding(.horizontal, Tokens.Spacing.s4)
            .padding(.bottom, Tokens.Spacing.s10)
        }
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        .navigationTitle("Recovery key")
        .navigationBarBackButtonHidden(store.replacing != .idle)
        .privacyCover()
        // However the screen goes, the keys go with it.
        .onDisappear { store.closeRecoveryKey() }
    }

    private var ask: some View {
        Group {
            Text("You get a new key to write down. Once it is saved, the old key stops working. Your devices are not affected.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
            RecoveryKeyField(label: "Your current recovery key", key: $typed)
            Button("Make a new key") { Task { await store.newRecoveryKey(current: typed) } }
                .buttonStyle(Primary(busy: store.busy))
                .disabled(store.busy || !RecoveryKeyField.complete(typed))
            Text("Lost it? Without the current key it can't be replaced. Your devices keep working.")
                .type(Tokens.Typography.small)
                .foregroundStyle(Tokens.Colors.fg2.color)
        }
    }

    private func shown(_ key: String, saving: Bool) -> some View {
        Group {
            Text("Your new recovery key").type(Tokens.Typography.heading)
            Text("Keep this key in a password manager or on paper. The old key works until you save this one.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
            RecoveryKeyShown(key: key, stored: $stored)
            Button("Save the new key") { Task { await store.saveRecoveryKey() } }
                .buttonStyle(Primary(busy: saving))
                .disabled(saving || !stored)
            if !saving {
                Button("Cancel") { store.closeRecoveryKey(); dismiss() }
                    .type(Tokens.Typography.small)
                    .underline()
                    .foregroundStyle(Tokens.Colors.fg2.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Sizes.tap)
            }
        }
    }

    private var done: some View {
        Group {
            Text("Recovery key replaced").type(Tokens.Typography.heading)
            Text("The old key no longer works. Your devices are not affected.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
            Button("Back to Devices") { dismiss() }.buttonStyle(Primary())
        }
    }
}

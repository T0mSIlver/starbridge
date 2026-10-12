import StarbridgeProtocol
import SwiftUI

/**
 * A browser or phone signed in to the account asks to join: compare the 6 digits it shows with
 * the ones here, then approve. Shown over any screen while the app is in front, as on Android.
 */
struct JoinPrompt: ViewModifier {
    let store: Store
    /** Requests put off with Later, until the app restarts. */
    @State private var later: Set<String> = []

    private var asking: JoinAsk? { store.joinAsks.first { !later.contains($0.id) && !$0.elsewhere } }

    private var shown: Bool {
        if case .idle = store.comparison { return asking != nil }
        return true
    }

    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(get: { shown }, set: { if !$0 { dismiss() } })) {
            JoinSheet(store: store, asking: asking, later: { later.insert($0) })
                .presentationDetents([.medium])
                .interactiveDismissDisabled(store.comparison != .idle)
        }
    }

    /** Swiped away: a request waits for later; an ended comparison closes. */
    private func dismiss() {
        if case .idle = store.comparison, let ask = asking { later.insert(ask.id) } else { store.closeComparison() }
    }
}

private struct JoinSheet: View {
    let store: Store
    let asking: JoinAsk?
    let later: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s4) {
            switch store.comparison {
            case .idle:
                if let ask = asking {
                    Text("Let \(ask.name) join?").type(Tokens.Typography.heading)
                    Text("A browser or phone signed in to your account asks to read and answer as a device. Compare digits with it before you approve.")
                        .type(Tokens.Typography.body)
                        .foregroundStyle(Tokens.Colors.fg2.color)
                    Spacer()
                    Button("Compare digits") { store.compareJoin(ask.id) }.buttonStyle(Primary(accent: true))
                    HStack(spacing: Tokens.Spacing.s2) {
                        Button("Later") { later(ask.id) }.buttonStyle(Secondary())
                        Button("Refuse") { Task { await store.refuseJoin(ask.id) } }.buttonStyle(Secondary()).foregroundStyle(Tokens.Colors.bad.color)
                    }
                }
            case let .waiting(ask):
                Text("Let \(ask.name) join?").type(Tokens.Typography.heading)
                HStack(spacing: Tokens.Spacing.s3) {
                    ProgressView()
                    Text("Waiting for \(ask.name)…").type(Tokens.Typography.body)
                }
                Spacer()
                Button("Refuse") { Task { await store.refuseJoin(ask.id) } }.buttonStyle(Secondary()).foregroundStyle(Tokens.Colors.bad.color)
            case let .digits(ask, digits, approving, error):
                Text("Same digits on \(ask.name)?").type(Tokens.Typography.heading)
                Text(Joins.formatDigits(digits))
                    .font(.system(size: 40, weight: .semibold).monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(digits.map(String.init).joined(separator: " "))
                Text("Approve only if \(ask.name) shows these same digits.").type(Tokens.Typography.body)
                if let error { Text(error).type(Tokens.Typography.body).foregroundStyle(Tokens.Colors.bad.color) }
                Spacer()
                Button(error != nil ? "Try again" : "Approve") { Task { await store.approveJoin() } }
                    .buttonStyle(Primary(busy: approving, accent: true))
                    .allowsHitTesting(!approving)
                Button("Digits differ") { Task { await store.refuseJoin(ask.id) } }
                    .buttonStyle(Secondary())
                    .foregroundStyle(Tokens.Colors.bad.color)
                    .disabled(approving)
            case let .done(message):
                Text(message).type(Tokens.Typography.heading)
                Spacer()
                Button("OK") { store.closeComparison() }.buttonStyle(Primary())
            case let .failed(message):
                Text("Not approved").type(Tokens.Typography.heading)
                Text(message).type(Tokens.Typography.body).foregroundStyle(Tokens.Colors.fg2.color)
                Spacer()
                Button("OK") { store.closeComparison() }.buttonStyle(Primary())
            }
        }
        .padding(Tokens.Spacing.s5)
        .padding(.top, Tokens.Spacing.s4)
        .foregroundStyle(Tokens.Colors.fg.color)
    }
}

extension View {
    func joinPrompt(store: Store) -> some View { modifier(JoinPrompt(store: store)) }
}

import AuthenticationServices
import StarbridgeProtocol
import SwiftUI

/** Setup, from signing in to joining the account: one screen per [Phase], as on Android. */
struct SetupView: View {
    let store: Store

    var body: some View {
        step.foregroundStyle(Tokens.Colors.fg.color)
    }

    @ViewBuilder private var step: some View {
        switch store.phase {
        case .signedOut: SignInStep(store: store)
        case .noDevice(accountExists: true): JoinStep(store: store)
        case .noDevice(accountExists: false): FirstDeviceStep(store: store)
        case .joining:
            WaitingStep(store: store, title: "Approve this iPhone", text: "Approve it on the device that shows the QR code.", digits: nil)
        case .joiningByDigits(nil, _):
            WaitingStep(store: store, title: "Compare digits", text: "Open Starbridge on a device you already use: it asks whether to let this iPhone join.", digits: nil)
        case let .joiningByDigits(digits, false):
            WaitingStep(store: store, title: "Compare digits", text: "Does your other device show the same digits?", digits: digits, onMatch: { store.confirmDigits() })
        case let .joiningByDigits(digits, true):
            WaitingStep(store: store, title: "Compare digits", text: "Approve on your other device.", digits: digits)
        case let .recoveryKey(key): RecoveryKeyStep(store: store, key: key)
        // The app shows the inbox instead.
        case .ready: EmptyView()
        }
    }
}

/** A setup step: `top` from the top, its actions at the bottom. */
private struct Step<Top: View, Bottom: View>: View {
    @ViewBuilder let top: Top
    @ViewBuilder let bottom: Bottom

    var body: some View {
        GeometryReader { screen in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    top
                    Spacer(minLength: Tokens.Spacing.s8)
                    VStack(spacing: Tokens.Spacing.s3) { bottom }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, Tokens.Spacing.s4)
                        .padding(.bottom, Tokens.Spacing.s6)
                }
                .frame(maxWidth: .infinity, minHeight: screen.size.height, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

enum SetupCopy {
    /** How a tester joins a demo server, which approves the iPhone by itself (#2089, Tom's pick). */
    static let demoJoin = "This demo approves your iPhone by itself: tap Compare digits, then They match."
}

private struct Title: View {
    let text: String

    var body: some View {
        Text(text)
            .type(Tokens.Typography.title)
            .padding(.horizontal, Tokens.Spacing.s4)
            .padding(.top, Tokens.Spacing.s12)
            .padding(.bottom, Tokens.Spacing.s4)
    }
}

private struct Lede: View {
    let text: String

    var body: some View {
        Text(text)
            .type(Tokens.Typography.body)
            .foregroundStyle(Tokens.Colors.fg2.color)
            .padding(.horizontal, Tokens.Spacing.s4)
    }
}

/**
 * The main action: the system's large prominent button (#1859), filled in `fg`, or the accent for
 * one that waits on the owner, the full width. Before iOS 26 has no flexible button size, so
 * there it stays the 56 pt capsule.
 */
private struct PrimaryButton: ViewModifier {
    let busy: Bool
    let accent: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let on = (accent ? Tokens.Colors.onAccent : Tokens.Colors.bg).color
            content
                .buttonStyle(.borderedProminent)
                .buttonSizing(.flexible)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint((accent ? Tokens.Colors.accent : Tokens.Colors.fg).color)
                .overlay {
                    // Covers the label: a system style sets its own foreground, so an outer one cannot hide it.
                    if busy { Capsule().fill((accent ? Tokens.Colors.accent : Tokens.Colors.fg).color).overlay { ProgressView().tint(on) } }
                }
                .foregroundStyle(on)
        } else {
            content.buttonStyle(CapsulePrimary(busy: busy, accent: accent))
        }
    }
}

/** The second action: the system's large bordered button, `destructive` in the bad colour. */
private struct SecondaryButton: ViewModifier {
    let destructive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.bordered)
                .buttonSizing(.flexible)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint((destructive ? Tokens.Colors.bad : Tokens.Colors.fg).color)
        } else {
            content.buttonStyle(CapsuleSecondary()).foregroundStyle(destructive ? Tokens.Colors.bad.color : Tokens.Colors.fg.color)
        }
    }
}

enum SystemButton {
    /** The system's large button, and the 56 pt capsule where it has no full-width size (before iOS 26). */
    static var height: CGFloat { if #available(iOS 26.0, *) { 50 } else { 56 } }
}

extension View {
    func primaryButton(busy: Bool = false, accent: Bool = false) -> some View { modifier(PrimaryButton(busy: busy, accent: accent)) }
    func secondaryButton(destructive: Bool = false) -> some View { modifier(SecondaryButton(destructive: destructive)) }
}

/** `PrimaryButton` before iOS 26. */
private struct CapsulePrimary: ButtonStyle {
    let busy: Bool
    let accent: Bool
    @Environment(\.isEnabled) private var enabled

    private var on: Color { (accent ? Tokens.Colors.onAccent : Tokens.Colors.bg).color }

    func makeBody(configuration: Configuration) -> some View {
        ZStack {
            configuration.label.opacity(busy ? 0 : 1)
            if busy { ProgressView().tint(on) }
        }
        .type(Tokens.Typography.action)
        .foregroundStyle(on)
        .frame(maxWidth: .infinity, minHeight: 56)
        .background(Pill(limit: 28).fill((accent ? Tokens.Colors.accent : Tokens.Colors.fg).color.opacity(enabled ? 1 : 0.38)))
        .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/** `SecondaryButton` before iOS 26. */
private struct CapsuleSecondary: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .type(Tokens.Typography.action)
            .frame(maxWidth: .infinity, minHeight: 56)
            .overlay(Pill(limit: 28).stroke(Tokens.Colors.lineStrong.color))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/** A text field on a filled box, its label above what it holds. */
struct Filled<Field: View>: View {
    let label: String
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s1) {
            Text(label).type(Tokens.Typography.caption).foregroundStyle(Tokens.Colors.fg2.color)
            field.type(Tokens.Typography.machine)
        }
        .padding(.horizontal, Tokens.Spacing.s4)
        .padding(.vertical, Tokens.Spacing.s2)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous).fill(Tokens.Colors.surface2.color))
    }
}

/** A quieter way: underlined text. */
private struct LinkButton: View {
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text).underline().type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.fg2.color)
        }
        .frame(minHeight: Tokens.Sizes.tap)
    }
}

/** The step's picture: a symbol on a rounded tile. */
private struct Tile: View {
    let symbol: String

    var body: some View {
        RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous)
            .fill(Tokens.Colors.surface.color)
            .frame(height: 200)
            .overlay {
                RoundedRectangle(cornerRadius: 32, style: .continuous)
                    .fill(Tokens.Colors.surface2.color)
                    .frame(width: 120, height: 120)
                    .overlay { Image(systemName: symbol).font(.system(size: 52)) }
            }
            .padding(.horizontal, Tokens.Spacing.s3)
            .accessibilityHidden(true)
    }
}

private struct SignInStep: View {
    let store: Store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var selfHosted = false
    @State private var nonce = ""
    @State private var server = ""
    @State private var token = ""
    @FocusState private var focus: Field?

    private enum Field { case server, token }

    private var canSignIn: Bool { !store.busy && !server.isEmpty && !token.isEmpty }

    var body: some View {
        Step {
            Lockup()
                .padding(.leading, Tokens.Spacing.s6)
                .padding(.top, 120)
            if selfHosted {
                VStack(spacing: Tokens.Spacing.s3) {
                    Filled(label: "Server") {
                        TextField("Server", text: edited($server), prompt: Text("https://starbridge.example.com"))
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .focused($focus, equals: .server)
                            .submitLabel(.next)
                            .onSubmit { focus = .token }
                    }
                    Filled(label: "Owner token") {
                        SecureField("Owner token", text: edited($token))
                            .focused($focus, equals: .token)
                            .submitLabel(.go)
                            .onSubmit { if canSignIn { signIn() } }
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, Tokens.Spacing.s4)
                .padding(.top, Tokens.Spacing.s8)
            }
            // Under the fields, where the keyboard leaves it in view, until the owner types or
            // tries again: an alert went by as the keyboard closed (#2085).
            if let notice = store.notice {
                Text(notice)
                    .type(Tokens.Typography.small)
                    .foregroundStyle(Tokens.Colors.bad.color)
                    .padding(.horizontal, Tokens.Spacing.s4)
                    .padding(.top, Tokens.Spacing.s3)
                    // A new failure is a new view, so VoiceOver reads each one.
                    .id(notice)
                    .onAppear { AccessibilityNotification.Announcement(notice).post() }
            }
        } bottom: {
            if !selfHosted {
                Button { gitHub(Store.defaultServer) } label: { Label { Text("Sign in with GitHub") } icon: { Image("GitHub").resizable().frame(width: 20, height: 20) } }
                    .primaryButton(busy: store.busy)
                    .disabled(store.busy)
                // As tall and as wide as GitHub's: App Store guideline 4.8 wants Apple's no less
                // prominent (spec/sign-in.md).
                SignInWithAppleButton(.signIn, onRequest: appleRequest, onCompletion: appleDone)
                    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                    .frame(height: SystemButton.height)
                    .clipShape(Capsule())
                    .disabled(store.busy)
                LinkButton(text: "Use your own server") {
                    selfHosted = true
                    if server.isEmpty { server = store.saved.server == Store.defaultServer ? "" : store.saved.server }
                }
            } else {
                Button("Sign in", action: signIn)
                    .primaryButton(busy: store.busy)
                    .disabled(!canSignIn)
                Button("Sign in with GitHub on this server") { gitHub(server) }
                    .secondaryButton()
                    .disabled(store.busy || server.isEmpty)
                LinkButton(text: "Use starbridge.run") { selfHosted = false }
            }
        }
    }

    /** The keyboard goes, so the button's progress and the outcome show. */
    private func signIn() {
        focus = nil
        Task { await store.signInWithOwnerToken(server: server, token: token) }
    }

    /** Typing again clears the last failure. */
    private func edited(_ text: Binding<String>) -> Binding<String> {
        Binding(get: { text.wrappedValue }, set: {
            text.wrappedValue = $0
            if store.notice != nil { store.notice = nil }
        })
    }

    /** Asks Apple for no name and no email: the account is Apple's user id alone (spec/sign-in.md). */
    private func appleRequest(_ request: ASAuthorizationAppleIDRequest) {
        nonce = SignIn.newNonce()
        request.requestedScopes = []
        request.nonce = SignIn.nonceHash(nonce)
    }

    private func appleDone(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case let .success(auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let token = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
                  let code = credential.authorizationCode.flatMap({ String(data: $0, encoding: .utf8) }) else {
                store.notice = "Apple sign-in didn't finish. Sign in again."
                return
            }
            Task { await store.signInWithApple(identityToken: token, code: code, nonce: nonce) }
        case let .failure(error):
            if (error as? ASAuthorizationError)?.code != .canceled { store.notice = store.describe(error) }
        }
    }

    /**
     * Opens GitHub's sign-in in the browser sheet, which shares Safari's GitHub sign-in. On
     * starbridge.run from iOS 17.4 it ends on the https callback GitHub redirects to (#1115);
     * elsewhere when the server hands the code on to starbridge://auth.
     */
    private func gitHub(_ server: String) {
        guard let url = store.gitHubSignInURL(server: server) else {
            store.notice = "That server address is not a URL."
            return
        }
        Task {
            do {
                let link: URL
                if #available(iOS 17.4, *), let https = SignIn.httpsCallback(server: store.saved.server) {
                    link = try await webAuthenticationSession.authenticate(
                        using: url, callback: .https(host: https.host, path: https.path),
                        preferredBrowserSession: .shared, additionalHeaderFields: [:])
                } else {
                    link = try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: "starbridge", preferredBrowserSession: .shared)
                }
                await store.receiveSignIn(link)
            } catch {
                store.abandonSignIn()
                if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { store.notice = store.describe(error) }
            }
        }
    }
}

/** The account has devices: this iPhone scans one's QR code, compares digits with it, or recovers. */
private struct JoinStep: View {
    let store: Store
    @State private var scanning = false
    @State private var recovering = false
    @State private var deleting = false

    var body: some View {
        Group {
            if recovering {
                RecoverStep(store: store, delete: { deleting = true }) { recovering = false }
            } else {
                join
            }
        }
        .deleteAccount(store: store, isPresented: $deleting, text: DeleteAccount.unpaired)
    }

    private var join: some View {
        Step {
            Title(text: "Add this iPhone")
            // A demo server approves every join itself: a tester has no other device to scan (#2089).
            if store.demo { Lede(text: SetupCopy.demoJoin).padding(.bottom, Tokens.Spacing.s4) }
            Tile(symbol: "qrcode")
        } bottom: {
            Button {
                Task {
                    if let why = await QRScanner.whyNot() { store.notice = why } else { scanning = true }
                }
            } label: {
                Label("Scan a QR code", systemImage: "qrcode.viewfinder")
            }
            .primaryButton(busy: store.busy)
            .disabled(store.busy)
            LinkButton(text: "Can't scan? Compare digits") { Task { await store.askDevices() } }
            // Three to a line when they fit, else stacked.
            ViewThatFits {
                HStack(spacing: Tokens.Spacing.s6) { links }
                VStack(spacing: 0) { links }
            }
        }
        .sheet(isPresented: $scanning) {
            QRScanner { text in
                scanning = false
                Task { await store.joinWithCode(text) }
            }
            .ignoresSafeArea()
        }
    }
}

extension JoinStep {
    @ViewBuilder fileprivate var links: some View {
        LinkButton(text: "Use the recovery key") { recovering = true }
        LinkButton(text: "Sign out") { Task { await store.signOut() } }
        // The way out without a device or the recovery key (#1117).
        LinkButton(text: "Delete account") { deleting = true }.disabled(store.busy)
    }
}

/**
 * An empty account: this iPhone makes its keys as the screen opens, and the recovery key follows
 * (#2139). Try again only once a try has run and failed.
 */
private struct FirstDeviceStep: View {
    let store: Store
    @State private var tried = false

    var body: some View {
        Step {
            Title(text: "Your recovery key")
            if !tried || store.busy {
                HStack(spacing: Tokens.Spacing.s3) {
                    ProgressView()
                    Text("Creating the keys")
                        .type(Tokens.Typography.body)
                        .foregroundStyle(Tokens.Colors.fg2.color)
                }
                .padding(.horizontal, Tokens.Spacing.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } bottom: {
            if tried && !store.busy {
                Button("Try again") { Task { await store.setUpFirstDevice() } }
                    .primaryButton(busy: store.busy)
            }
            LinkButton(text: "Sign out") { Task { await store.signOut() } }
        }
        .task {
            guard !tried else { return }
            await store.setUpFirstDevice()
            tried = true
        }
    }
}

/** The recovery key, typed: it adds this iPhone and removes every other device and machine. */
private struct RecoverStep: View {
    let store: Store
    /** Delete account, where an owner who lost the key looks (#1195). */
    let delete: () -> Void
    let back: () -> Void
    @State private var key = ""

    var body: some View {
        Step {
            Title(text: "Recovery key")
            Lede(text: "Recovering removes every other device and machine from the account. Pair the ones you still have again from this iPhone afterwards.")
            RecoveryKeyField(label: "Your recovery key", key: $key)
            .padding(.horizontal, Tokens.Spacing.s4)
            .padding(.top, Tokens.Spacing.s6)
        } bottom: {
            Button("Recover") { Task { await store.recover(key) } }
                .primaryButton(busy: store.busy)
                .disabled(store.busy || !RecoveryKeyField.complete(key))
            HStack(spacing: Tokens.Spacing.s6) {
                LinkButton(text: "Back", action: back)
                // A delete confirmed while Recover runs would do nothing.
                LinkButton(text: "Delete account", action: delete).disabled(store.busy)
            }
        }
        .privacyCover()
    }
}

/**
 * The first device's recovery key, shown once: Continue posts the account's first entry (#370),
 * which can take a moment, or fail and stay here.
 */
private struct RecoveryKeyStep: View {
    let store: Store
    let key: String
    @State private var stored = false

    var body: some View {
        Step {
            Title(text: "Your recovery key")
            Lede(text: "Keep this key in a password manager or on paper. If you lose every device, it adds a new one. This is the only time it is shown.")
            RecoveryKeyShown(key: key, stored: $stored)
            .padding(.horizontal, Tokens.Spacing.s4)
            .padding(.top, Tokens.Spacing.s6)
        } bottom: {
            Button("Continue") { Task { await store.confirmRecoveryKey() } }
                .primaryButton(busy: store.busy)
                .disabled(store.busy || !stored)
            LinkButton(text: "Sign out") { Task { await store.signOut() } }
        }
        .privacyCover()
    }
}

/** A recovery key to type: masked as a password, with the eye to check what was typed (#274). */
struct RecoveryKeyField: View {
    let label: String
    @Binding var key: String
    @State private var shown = false

    static func complete(_ key: String) -> Bool {
        let reading = RecoveryKeys.read(key, typing: true)
        return reading.problem == nil && reading.count == RecoveryKeyText.chars
    }

    var body: some View {
        let reading = RecoveryKeys.read(key, typing: true)
        VStack(alignment: .leading, spacing: Tokens.Spacing.s1) {
            Filled(label: label) {
                HStack {
                    Group {
                        if shown {
                            TextField(label, text: $key, prompt: Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"))
                        } else {
                            SecureField(label, text: $key, prompt: Text("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"))
                        }
                    }
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textContentType(.password)
                    Button { shown.toggle() } label: { Image(systemName: shown ? "eye.slash" : "eye") }
                        .frame(minWidth: Tokens.Sizes.tap, minHeight: Tokens.Sizes.tap)
                        .accessibilityLabel(shown ? "Hide the key" : "Show the key")
                }
            }
            Text(RecoveryKeyText.problem(reading) ?? RecoveryKeyText.status(reading))
                .type(Tokens.Typography.caption)
                .foregroundStyle(reading.problem == nil ? Tokens.Colors.fg2.color : Tokens.Colors.bad.color)
                .padding(.horizontal, Tokens.Spacing.s4)
        }
    }
}

/** A new recovery key, shown once: in groups of four, with Copy and "I stored this key". */
struct RecoveryKeyShown: View {
    let key: String
    @Binding var stored: Bool
    @State private var copied = false

    var body: some View {
        VStack(spacing: Tokens.Spacing.s3) {
            // Groups of four, never split across lines.
            Text(key.split(separator: "-").joined(separator: " "))
                .font(.system(size: 22, design: .monospaced))
                .tracking(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(Tokens.Spacing.s5)
                .background(RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous).fill(Tokens.Colors.surface.color))
                .accessibilityLabel(key.map(String.init).joined(separator: " "))
            Button {
                RecoveryKeyText.copy(key)
                copied = true
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            .secondaryButton()
            if copied {
                Text("Copied. The clipboard clears itself in a minute.")
                    .type(Tokens.Typography.small)
                    .foregroundStyle(Tokens.Colors.fg2.color)
            }
            Toggle("I stored this key", isOn: $stored)
                .type(Tokens.Typography.body)
                .frame(minHeight: Tokens.Sizes.tap)
        }
    }
}

/** Waiting for another device to approve this one, with the digits to compare when there are some. */
private struct WaitingStep: View {
    let store: Store
    let title: String
    let text: String
    let digits: String?
    var onMatch: (() -> Void)?

    var body: some View {
        Step {
            Title(text: title)
            Lede(text: text)
            if let digits {
                Text(Joins.formatDigits(digits))
                    .font(.system(size: 40, weight: .semibold).monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Tokens.Spacing.s10)
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.xl, style: .continuous).fill(Tokens.Colors.surface.color))
                    .padding(.horizontal, Tokens.Spacing.s3)
                    .padding(.top, Tokens.Spacing.s6)
                    .accessibilityLabel(digits.map(String.init).joined(separator: " "))
            }
            if onMatch == nil {
                HStack(spacing: Tokens.Spacing.s3) {
                    ProgressView()
                    Text("Waiting for the approval").type(Tokens.Typography.body).foregroundStyle(Tokens.Colors.fg2.color)
                }
                .padding(Tokens.Spacing.s4)
            }
        } bottom: {
            if let onMatch { Button("They match", action: onMatch).primaryButton() }
            Button("Cancel") { Task { await store.cancelJoin() } }.secondaryButton()
        }
        .privacyCover()
    }
}

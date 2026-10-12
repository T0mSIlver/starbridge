import CoreImage.CIFilterBuiltins
import SwiftUI

/**
 * Adding a machine or device, as Android's Add a device: a code looked up, scanned or typed, is
 * checked against its secret before the request shows, and Approve appends its keys to the
 * directory; or this iPhone shows a QR code for a new phone (spec/keys-and-trust.md, "Pairing").
 */
struct AddDeviceView: View {
    let store: Store
    /** A code or link to look up as the screen opens: scanned in Devices, or a pairing link. */
    var lookUp: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
                PairCard(store: store)
            }
            .padding(Tokens.Spacing.s5)
            .background(RoundedRectangle(cornerRadius: Tokens.Radius.xl).fill(Tokens.Colors.surface.color))
            .padding(.horizontal, Tokens.Spacing.s4)
            .animation(.default, value: store.approval)
        }
        .background(Tokens.Colors.bg.color.ignoresSafeArea())
        .navigationTitle("Add a device")
        .task {
            if let lookUp { await store.lookUpPairing(lookUp) }
        }
        // A request left on screen waits no more once the screen goes.
        .onDisappear { store.closePairing() }
    }
}

private struct PairCard: View {
    let store: Store
    @State private var code = ""
    @State private var scanning = false
    @State private var scanError: String?

    var body: some View {
        Group {
            switch store.approval {
            case let .found(j), let .approving(j): asking(j)
            case let .showing(code, link): showing(code: code, link: link)
            default: ways
            }
        }
        // The approved code is spent: the card offers the next pairing with an empty field.
        .onChange(of: store.approval) { _, now in if case .done = now { code = "" } }
    }

    /** A request to approve needs the owner, so it carries the accent dot. */
    private func asking(_ j: Joiner) -> some View {
        let approving = store.approval == .approving(j)
        return VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            HStack(spacing: Tokens.Spacing.s2) {
                Circle().fill(Tokens.Colors.accent.color).frame(width: 8, height: 8).accessibilityHidden(true)
                Text("Wants to join").type(Tokens.Typography.label)
            }
            Text(j.name).type(Tokens.Typography.question)
            Text(j.machine ? "A machine: its agents can ask you decisions and send quotas." : "A device: it can read and answer decisions.")
                .type(Tokens.Typography.body)
                .foregroundStyle(Tokens.Colors.fg2.color)
            Text(j.code).type(Tokens.Typography.machine).foregroundStyle(Tokens.Colors.fg2.color)
            HStack(spacing: Tokens.Spacing.s2) {
                Button("Approve") { Task { await store.approvePairing() } }
                    .buttonStyle(Primary(busy: approving, accent: true))
                    .allowsHitTesting(!approving)
                Button("Cancel") { store.closePairing(); code = "" }
                    .buttonStyle(Secondary())
                    .frame(width: 120)
            }
        }
    }

    /** This iPhone shows a pairing link as a QR code and waits for a new phone to scan it. */
    private func showing(code shown: String, link: String) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            Text("Scan with the new phone").type(Tokens.Typography.heading)
            Text("On the new phone, sign in to Starbridge and tap Scan a QR code. It expires in 10 minutes.")
                .type(Tokens.Typography.small)
                .foregroundStyle(Tokens.Colors.fg2.color)
            QRImage(text: link).accessibilityLabel("QR code for pairing code \(shown)")
            Text(shown).type(Tokens.Typography.machine).foregroundStyle(Tokens.Colors.fg2.color)
            Button("Cancel") { store.closePairing(); code = "" }.buttonStyle(Secondary()).frame(width: 120)
        }
    }

    /** Scan a code another device or `starbridge pair` shows, show one, or type it. */
    private var ways: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s3) {
            // A pairing that just ended says so above the ways to pair the next one.
            if case let .done(name) = store.approval {
                Label("\(name) joined.", systemImage: "checkmark.circle.fill").type(Tokens.Typography.body)
            }
            Text("Add a machine or device").type(Tokens.Typography.heading)
            Button {
                Task {
                    if let why = await QRScanner.whyNot(typing: true) { scanError = why } else { scanError = nil; scanning = true }
                }
            } label: {
                Text("Scan a QR code")
            }
            .buttonStyle(Primary())
            Button("Show a QR code for a new phone") { store.showCode() }.buttonStyle(Secondary())
            if let scanError { Text(scanError).type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.bad.color) }
            Text("Or type the code it shows: starbridge pair on a machine, or Join on a new phone or browser.")
                .type(Tokens.Typography.small)
                .foregroundStyle(Tokens.Colors.fg2.color)
            Filled(label: "Pairing code") {
                TextField("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { Task { await store.lookUpPairing(code) } }
                    .onChange(of: code) { _, new in if new.count > 40 { code = String(new.prefix(40)) } }
            }
            if case let .failed(why) = store.approval {
                Text(why).type(Tokens.Typography.small).foregroundStyle(Tokens.Colors.bad.color)
            }
            Button {
                Task { await store.lookUpPairing(code) }
            } label: {
                Text("Check code")
            }
            .buttonStyle(Secondary())
            .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || store.approval == .checking)
        }
        .sheet(isPresented: $scanning) {
            QRScanner { text in
                scanning = false
                Task { await store.lookUpPairing(text) }
            }
            .ignoresSafeArea()
        }
    }
}

/** `text` as a QR code: black modules on a white square, in light and dark alike. */
struct QRImage: View {
    let text: String

    var body: some View {
        Image(uiImage: Self.image(text))
            .interpolation(.none)
            .resizable()
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 260)
            .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.sm))
    }

    static func image(_ text: String) -> UIImage {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let modules = filter.outputImage else { return UIImage() }
        // Two modules of white around the code, as on Android.
        let framed = modules.transformed(by: CGAffineTransform(translationX: 2, y: 2))
            .composited(over: CIImage(color: .white).cropped(to: modules.extent.insetBy(dx: -2, dy: -2).offsetBy(dx: 2, dy: 2)))
        guard let cg = CIContext().createCGImage(framed, from: framed.extent) else { return UIImage() }
        return UIImage(cgImage: cg)
    }
}

import AVFoundation
import SwiftUI
import VisionKit

/** The camera, reading the first QR code it sees. */
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    /**
     * Whether the scanner can open, asking for the camera the first time: VisionKit counts it
     * unavailable until the owner allows the camera. Nil when it can, else why not, and the other
     * way: typing the code when adding a device, comparing digits when joining.
     */
    static func whyNot(typing: Bool = false) async -> String? {
        let instead = typing ? "Type the code instead." : "Compare digits instead."
        guard DataScannerViewController.isSupported else { return "This iPhone can't scan QR codes. \(instead)" }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        if AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
            return "Starbridge can't use the camera. Allow it in Settings, or \(instead.prefix(1).lowercased() + instead.dropFirst())"
        }
        return DataScannerViewController.isAvailable ? nil : "The camera is busy or restricted. \(instead)"
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(code) in items {
                guard !done, let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                onCode(text)
            }
        }
    }
}

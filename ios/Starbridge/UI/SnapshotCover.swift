import SwiftUI
import UIKit

/**
 * Covers the app with its background while it is in the background, so the app switcher's
 * snapshot shows no question, prompt or inbox (security audit 2026-10-20). A window above the
 * others covers the sheets too, which an overlay on the root view would not. It goes up as the
 * scene enters the background, where iOS takes the snapshot, and not at every inactive moment,
 * so a system alert or Notification Center pulled over the app leaves it as it is.
 */
@MainActor
final class SnapshotCover {
    private var covers: [ObjectIdentifier: UIWindow] = [:]
    private var observers: [NSObjectProtocol] = []

    func install(_ center: NotificationCenter = .default) {
        observers.append(center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIWindowScene
            MainActor.assumeIsolated { if let scene { self?.cover(scene) } }
        })
        observers.append(center.addObserver(forName: UIScene.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIWindowScene
            MainActor.assumeIsolated { if let scene { self?.uncover(scene) } }
        })
    }

    /** The cover over `scene`'s windows, while it is up. */
    func window(over scene: UIWindowScene) -> UIWindow? { covers[ObjectIdentifier(scene)] }

    func cover(_ scene: UIWindowScene) {
        guard covers[ObjectIdentifier(scene)] == nil else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        let root = UIViewController()
        root.view.backgroundColor = UIColor(Tokens.Colors.bg.color)
        window.rootViewController = root
        window.isHidden = false
        covers[ObjectIdentifier(scene)] = window
    }

    func uncover(_ scene: UIWindowScene) {
        covers.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
    }
}

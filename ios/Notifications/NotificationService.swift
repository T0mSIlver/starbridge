import Foundation
import UserNotifications

/**
 * Replaces the server's placeholder ("A question needs you") with what the sealed box says, as
 * Android's app does on a data push: APNs shows only what an alert carries, so every question
 * arrives as an alert the extension rewrites (research/ios-app.md, "Push: APNs"). The work is
 * `Notify.rewrite`. Whatever fails, or runs out of time, leaves the placeholder without a
 * question's buttons (`Notify.unread`).
 */
// iOS calls in on one queue; the content goes back once, from `finish`.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNNotificationContent?
    private var task: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        content = request.content
        // Only the payload, which is Sendable, goes into the task.
        let p = Notify.payload(request.content.userInfo)
        task = Task {
            let shown = await Notify.rewrite(p)
            self.finish(shown)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        task?.cancel()
        finish(nil)
    }

    private func finish(_ shown: Shown?) {
        guard let handler, let content else { return }
        self.handler = nil
        guard let rewritten = content.mutableCopy() as? UNMutableNotificationContent else { return handler(content) }
        if let shown { Notify.apply(shown, to: rewritten) } else { Notify.unread(rewritten) }
        handler(rewritten)
    }
}

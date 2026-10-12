import Foundation
import UIKit
import UIKit.UIGestureRecognizerSubclass

/**
 * Presence (#848): while the app is in front and was touched in the last minute, the owner is
 * using this iPhone, so the server holds the other devices' pushes. Only that bit reaches the
 * server, never what was touched. The timings are packages/protocol's (`presence.ts`). The
 * caller runs every call on the main actor.
 */
@MainActor
final class Beacon {
    static let inputWindow: TimeInterval = 60
    static let beat: TimeInterval = 30
    /** How often the app checks whether it still counts. */
    static let check: TimeInterval = 10
    /** No hold: every device's push goes at once (PUSH_HOLD_OFF). */
    static let holdOff = 0
    /** A hold that ends as soon as the owner leaves (PUSH_HOLD_ON_LEAVE, #1060). */
    static let holdOnLeave = -1
    /** The hold choices offered: off, or how long after the owner left the last screen. */
    static let holdChoices = [holdOff, holdOnLeave, 15, 30, 60]

    private let send: (Bool) async throws -> Void
    private let now: () -> Date
    private var lastInput = Date.distantPast
    private var sent: (present: Bool, at: Date)?

    init(send: @escaping (Bool) async throws -> Void, now: @escaping () -> Date = Date.init) {
        self.send = send
        self.now = now
    }

    func present(inFront: Bool) -> Bool { inFront && now().timeIntervalSince(lastInput) < Self.inputWindow }

    /** A touch or a key; returns whether it made the iPhone present, so the caller ticks at once. */
    func input(inFront: Bool) -> Bool {
        let was = present(inFront: inFront)
        lastInput = now()
        return !was && present(inFront: inFront)
    }

    /** Says present when it is, again once a beat passed, and absent once it is not. */
    func tick(inFront: Bool) async {
        let present = present(inFront: inFront)
        let at = now()
        if present, sent?.present != true || at.timeIntervalSince(sent!.at) >= Self.beat {
            // A failed beat is tried again a beat later, not at every check: a server without
            // the route refuses it every time.
            sent = (true, at)
            try? await send(true)
        } else if !present, sent?.present == true {
            sent = (false, at)
            try? await send(false)
        }
    }

    static func holdLabel(_ seconds: Int) -> String {
        switch seconds {
        case holdOff: "Off"
        case holdOnLeave: "0 s"
        case let s where s % 60 == 0: "\(s / 60) min"
        default: "\(seconds) s"
        }
    }
}

/**
 * Sees every touch in the window without taking any: it fails at once, so buttons, scrolls and
 * swipes work as before.
 */
final class TouchWatcher: UIGestureRecognizer {
    var onTouch: () -> Void = {}

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        onTouch()
        state = .failed
    }
}

extension Store {
    /** In front, the iPhone checks every 10 s whether it still counts; sent behind, it says absent once. */
    func foreground(_ on: Bool) {
        inFront = on
        presenceTask?.cancel()
        presenceTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                guard phase == .ready else { return }
                // The update screen replaces the tabs and their touches: say absent, and stop.
                let shown = inFront && tooOld == nil
                await beacon.tick(inFront: shown)
                if !shown { return }
                try? await Task.sleep(for: .seconds(Beacon.check))
            }
        }
    }

    /** A touch or a typed key; never which. */
    func touched() {
        guard phase == .ready, beacon.input(inFront: inFront) else { return }
        Task { await beacon.tick(inFront: inFront) }
    }

    func loadPushHold() async {
        // A server without the setting shows no row.
        if let hold = try? await api().pushHold() { pushHold = hold }
    }

    func setPushHold(_ seconds: Int) async {
        let was = pushHold
        pushHold = seconds
        do {
            pushHold = try await api().setPushHold(seconds)
        } catch {
            pushHold = was
            notice = describe(error)
        }
    }
}

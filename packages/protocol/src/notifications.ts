import { z } from "zod";

/**
 * A device's own notifications (#943). Each browser, desktop app and phone says whether it
 * notifies, so every device's Devices list shows them all; only the device itself changes its
 * state, so a device turned off from elsewhere never surprises the one holding it. Phones report
 * what Android says, browsers their permission and push subscription, the desktop app its own
 * switch. The server stores the state and pushes as before: a browser turned off drops its own
 * subscription.
 */
export const NotifyState = z.enum(["on", "off", "blocked"]);
export type NotifyState = z.infer<typeof NotifyState>;

/** `PUT /notifications`: this device's state. */
export const DeviceNotifications = z.object({ state: NotifyState });
export type DeviceNotifications = z.infer<typeof DeviceNotifications>;

/**
 * `GET /notifications`: each device that has said, by member id. `clients`: which app each of
 * those devices last said it from (#1019), so Devices shows a phone, a browser or the desktop app.
 * The server knows it from how the device signs in, never from a user agent; a name it may add
 * later reads as a plain device.
 */
export const NotificationStates = z.object({
  devices: z.record(z.string(), NotifyState),
  clients: z.record(z.string(), z.string()).optional(),
});
export type NotificationStates = z.infer<typeof NotificationStates>;

/**
 * `GET /auth/app/signed-in?state=<challenge>`: whether the app whose sign-in this browser just
 * carried now has a session for the caller's own account. The browser that passes an app's
 * GitHub sign-in on runs on the app's own machine, so a yes is proof, not a guess, that both
 * notify the same person there; the page then offers to turn off this browser's notifications.
 */
export const AppSignedIn = z.object({ signedIn: z.boolean() });
export type AppSignedIn = z.infer<typeof AppSignedIn>;

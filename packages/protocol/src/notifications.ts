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

/** `GET /notifications`: each device that has said, by member id. */
export const NotificationStates = z.object({ devices: z.record(z.string(), NotifyState) });
export type NotificationStates = z.infer<typeof NotificationStates>;

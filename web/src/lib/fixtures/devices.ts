import { ago } from "../now";
import type { Device } from "../types";

// Fake 32-byte keys, base64url.
const key = (seed: string) => seed.repeat(43).slice(0, 43);

export const devices: Device[] = [
  {
    id: "dev-1",
    role: "device",
    name: "Firefox on Mac",
    boxPk: key("fXbox1"),
    signPk: key("7F3A91C2"),
    kind: "browser",
    addedAt: ago(3 * 24 * 60),
    lastSeen: ago(0),
    status: "active",
    self: true,
  },
  {
    id: "dev-2",
    role: "device",
    name: "Pixel 11 Pro",
    boxPk: key("pXbox2"),
    signPk: key("C0D45E18"),
    kind: "phone",
    addedAt: ago(3 * 24 * 60 - 30),
    lastSeen: ago(6),
    status: "active",
  },
];

export const machines: Device[] = [
  {
    id: "m-3",
    role: "machine",
    name: "mac",
    boxPk: key("mXbox3"),
    signPk: key("4B92E07D"),
    kind: "machine",
    addedAt: ago(3),
    lastSeen: ago(1),
    status: "pending",
    pairingCode: "481-207",
  },
  {
    id: "m-1",
    role: "machine",
    name: "devbox",
    boxPk: key("dXbox1"),
    signPk: key("9A1E33F0"),
    kind: "machine",
    addedAt: ago(2 * 24 * 60),
    lastSeen: ago(1),
    status: "active",
  },
  {
    id: "m-2",
    role: "machine",
    name: "minipc",
    boxPk: key("nXbox2"),
    signPk: key("E5C20B71"),
    kind: "machine",
    addedAt: ago(2 * 24 * 60),
    lastSeen: ago(26 * 60),
    status: "active",
  },
];

/** An Ed25519 seed printed as words; shown once at first-device setup. */
export const recoveryWords = [
  "orbit",
  "lantern",
  "harbor",
  "velvet",
  "cobalt",
  "meadow",
  "signal",
  "anchor",
  "ember",
  "quartz",
  "willow",
  "beacon",
  "tundra",
  "falcon",
  "prism",
  "saddle",
  "glacier",
  "copper",
  "nectar",
  "rocket",
  "summit",
  "ripple",
  "canyon",
  "zephyr",
];

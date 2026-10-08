import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { PRESENCE_BEAT_MS } from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { Presence } from "../src/agent/presence";
import type { Hub } from "../src/agent/server";
import { run } from "../src/cli";
import {
  graphical,
  linuxIdleMs,
  macIdleMs,
  macLocked,
  type Screen,
  screenReader,
  windowsScreen,
} from "../src/screen";
import { paired, type TestCtx } from "./helpers";

setDefaultTimeout(30_000);

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

/** `ioreg -c IOHIDSystem -d 4 -r -k HIDIdleTime` and `ioreg -n Root -d1` on macOS 26 (trimmed). */
const MAC_HID = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000483, registered, matched, active, busy 0 (0 ms), retain 22>
    {
      "HIDIdleTime" = 4213374958
    }`;
const MAC_ROOT_LOCKED = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 31>
    {
      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kSCSecuritySessionID"=100015,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserNameKey"="tom"})
    }`;
const MAC_ROOT = MAC_ROOT_LOCKED.replace('"CGSSessionScreenIsLocked"=Yes,', "");

test("each OS's output reads as lock and idle time, and anything else as no screen", async () => {
  expect(macIdleMs(MAC_HID)).toBeCloseTo(4213.37, 1);
  expect(macLocked(MAC_ROOT_LOCKED)).toBe(true);
  expect(macLocked(MAC_ROOT)).toBe(false);
  const session = (type: string, locked: string) =>
    `Type=${type}\nActive=yes\nClass=user\nLockedHint=${locked}\n`;
  expect(graphical([session("wayland", "no"), session("tty", "no")])).toEqual([{ locked: false }]);
  expect(graphical([session("tty", "no")])).toEqual([]);
  expect(linuxIdleMs("(uint64 15234,)\n")).toBe(15234);
  expect(linuxIdleMs("812\n")).toBe(812);
  expect(linuxIdleMs("Error: no such name")).toBeUndefined();
  expect(windowsScreen("5300 False")).toEqual({ idleMs: 5300, locked: false });
  expect(windowsScreen("-1 False")).toBeUndefined();

  const outputs: Record<string, string | undefined> = {
    "ioreg -c IOHIDSystem -d 4 -r -k HIDIdleTime": MAC_HID,
    "ioreg -n Root -d1": MAC_ROOT,
  };
  const mac = screenReader("darwin", async (cmd, args) => outputs[[cmd, ...args].join(" ")]);
  expect(await mac.read()).toEqual({ locked: false, idleMs: expect.closeTo(4213.37, 1) });
  // A headless Linux box lists no graphical session: no signal at all.
  const headless = screenReader("linux", async (cmd, args) =>
    args[0] === "list-sessions"
      ? "3 1000 dev - -\n"
      : cmd === "loginctl"
        ? "Type=tty\nActive=yes\nClass=user\nLockedHint=no\n"
        : "(uint64 10,)",
  );
  expect(await headless.read()).toBeUndefined();
});

function hub(ctx: TestCtx): Hub {
  return {
    ctx,
    notify: () => {},
    changed: async () => {},
    log: () => {},
    seen: () => false,
  };
}

test("an opted-in machine says present while used, beats, and says absent once locked or idle", async () => {
  const ctx = await paired(server);
  let screen: Screen | undefined = { locked: false, idleMs: 2_000 };
  const p = new Presence(hub(ctx), { read: async () => screen, stop: () => {} });
  const me = ctx.store.machine()?.id as string;

  // Off by default: nothing is read or sent.
  await p.tick();
  expect(server.present()).toEqual([]);

  expect(await run(["config", "presence", "on"], ctx)).toBe(0);
  expect(ctx.lines).toContain("presence      on");
  const t0 = Date.now();
  await p.tick(t0);
  expect(server.present()).toEqual([me]);
  screen = { locked: false, idleMs: 70_000 };
  await p.tick(t0 + 10_000);
  expect(server.present()).toEqual([]);
  screen = { locked: false, idleMs: 100 };
  await p.tick(t0 + 20_000);
  expect(server.present()).toEqual([me]);
  screen = { locked: true, idleMs: 100 };
  await p.tick(t0 + 30_000);
  expect(server.present()).toEqual([]);

  // A headless box (no screen) sends nothing; turning presence off says absent once.
  screen = undefined;
  await p.tick(t0 + 40_000);
  expect(server.present()).toEqual([]);
  screen = { locked: false, idleMs: 0 };
  await p.tick(t0 + 50_000);
  expect(await run(["config", "presence", "off"], ctx)).toBe(0);
  await p.tick(t0 + 50_000 + PRESENCE_BEAT_MS);
  expect(server.present()).toEqual([]);
});

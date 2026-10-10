import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Reading, Screen } from "../../src/screen";

/** A powerMonitor whose idle seconds and lock state the test sets. */
function setup(idle: boolean, state = "active") {
  const monitor = Object.assign(new EventEmitter(), {
    idleS: 5,
    state,
    getSystemIdleTime: () => monitor.idleS,
    getSystemIdleState: () => monitor.state,
  });
  const told: Reading[] = [];
  const screen = new Screen(monitor, (r) => told.push(r), idle);
  return { monitor, screen, told };
}

test("with presence on, the page gets the idle time at every check, and away on lock", () => {
  const { monitor, screen, told } = setup(true);
  screen.check();
  monitor.idleS = 120;
  screen.check();
  expect(told).toEqual([
    { away: false, idleMs: 5_000 },
    { away: false, idleMs: 120_000 },
  ]);
  monitor.idleS = 0;
  monitor.emit("lock-screen");
  expect(told.at(-1)).toEqual({ away: true, idleMs: 0 });
  // macOS can still report locked as the unlock arrives: the event wins.
  monitor.state = "locked";
  monitor.emit("unlock-screen");
  expect(told.at(-1)).toEqual({ away: false, idleMs: 0 });
  screen.check();
  expect(told.at(-1)?.away).toBe(false);
});

test("a lock from before the app started, which sent no event, makes the owner away", () => {
  const { monitor, screen, told } = setup(true, "locked");
  screen.check();
  expect(told.at(-1)?.away).toBe(true);
  monitor.emit("unlock-screen");
  expect(told.at(-1)?.away).toBe(false);
});

test("with presence off, the idle time is never read, and only lock, sleep and quit are told", () => {
  const { monitor, screen, told } = setup(false);
  monitor.getSystemIdleTime = () => {
    throw new Error("read");
  };
  monitor.getSystemIdleState = () => {
    throw new Error("read");
  };
  screen.check();
  screen.check();
  expect(told).toEqual([{ away: false, idleMs: null }]);
  monitor.emit("suspend");
  monitor.emit("resume");
  monitor.emit("lock-screen");
  screen.quit();
  expect(told.map((r) => r.away)).toEqual([false, true, false, true, true]);
});

test("asleep or quitting, the owner is away and no idle time is sent", () => {
  const { monitor, screen, told } = setup(true);
  monitor.emit("suspend");
  expect(told.at(-1)).toEqual({ away: true, idleMs: null });
  monitor.emit("resume");
  expect(told.at(-1)).toEqual({ away: false, idleMs: 5_000 });
  screen.setIdle(false);
  expect(told.at(-1)).toEqual({ away: false, idleMs: null });
  screen.setIdle(true);
  screen.quit();
  expect(told.at(-1)).toEqual({ away: true, idleMs: null });
});

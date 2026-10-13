import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { MenuBar, trayImageName } from "../../src/menubar";

test("the arch alone is a template; the amber dot picks its arch by the menu bar", () => {
  expect(trayImageName(0, true)).toBe("trayTemplate");
  expect(trayImageName(0, false)).toBe("trayTemplate");
  expect(trayImageName(2, true)).toBe("trayWaitingDark");
  expect(trayImageName(2, false)).toBe("trayWaitingLight");
});

class FakeProbe extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
  say(text: string) {
    this.stdout.emit("data", text);
  }
}

function setup() {
  const probes: FakeProbe[] = [];
  let changes = 0;
  const bar = new MenuBar(
    () => changes++,
    () => {
      const p = new FakeProbe();
      probes.push(p);
      return p;
    },
  );
  return { bar, probes: probes as [FakeProbe, ...FakeProbe[]], changes: () => changes };
}

test("the bar's appearance follows the probe's lines, and only a change repaints", () => {
  const { bar, probes, changes } = setup();
  bar.watch(true);
  bar.watch(true);
  expect(probes).toHaveLength(1);
  probes[0].say("da");
  probes[0].say("rk\n");
  expect(bar.dark).toBe(true);
  probes[0].say("dark\n");
  expect(changes()).toBe(1);
  probes[0].say("light\n");
  expect(bar.dark).toBe(false);
  expect(changes()).toBe(2);
});

test("stopping kills the probe and forgets the appearance", () => {
  const { bar, probes } = setup();
  bar.watch(true);
  probes[0].say("dark\n");
  bar.watch(false);
  expect(probes[0].killed).toBe(true);
  expect(bar.dark).toBeNull();
});

test("a probe that dies is not restarted until the dot goes", () => {
  const { bar, probes, changes } = setup();
  bar.watch(true);
  probes[0].say("light\n");
  probes[0].emit("exit");
  expect(bar.dark).toBeNull();
  expect(changes()).toBe(2);
  bar.watch(true);
  expect(probes).toHaveLength(1);
  bar.watch(false);
  bar.watch(true);
  expect(probes).toHaveLength(2);
});

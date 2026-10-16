import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { appMenu, contextMenu } from "../../src/appmenu";

const actions = { settings() {}, find() {}, docs() {}, development: false };

const labels = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((i) => [
    i.label ?? i.role ?? "-",
    ...labels((i.submenu as MenuItemConstructorOptions[]) ?? []),
  ]);

test("the app menu has Settings… on ⌘, and Find… on ⌘F, as the owner picked (card d_acid-creek-health)", () => {
  const menu = appMenu(actions);
  expect(menu.map((m) => m.label ?? m.role)).toEqual([
    "Starbridge",
    "File",
    "Edit",
    "View",
    "windowMenu",
    "help",
  ]);
  const find = (label: string) =>
    menu
      .flatMap((m) => (m.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
      .find((i) => i.label === label);
  expect(find("Settings…")?.accelerator).toBe("Command+,");
  expect(find("Find…")?.accelerator).toBe("Command+F");
  expect(labels(menu)).toContain("Starbridge Docs");
});

test("a release has no Developer Tools, a development run keeps them", () => {
  expect(labels(appMenu(actions))).not.toContain("toggleDevTools");
  expect(labels(appMenu({ ...actions, development: true }))).toContain("toggleDevTools");
});

test("right-click: Copy and Look Up on a selection, Copy Link on a link, edit items in a field, nothing on bare space", () => {
  const to = { copyLink() {}, lookUp() {} };
  const at = (linkURL: string, selectionText: string, isEditable = false) =>
    labels(contextMenu({ linkURL, selectionText, isEditable }, to));
  expect(at("", "Ship")).toEqual(["copy", "Look Up “Ship”", "-", "selectAll"]);
  expect(at("https://x.test/a", "Docs")).toEqual([
    "Copy Link",
    "-",
    "copy",
    "Look Up “Docs”",
    "-",
    "selectAll",
  ]);
  expect(at("", "", true)).toEqual(["cut", "copy", "paste", "selectAll"]);
  expect(at("", "  ")).toEqual([]);
  // A long or multi-line selection becomes one short line, never a split emoji.
  expect(at("", `${"a".repeat(23)}😀😀\nsecond line`)[1]).toBe(`Look Up “${"a".repeat(23)}😀…”`);
});

test("Copy Link copies the link under the pointer", () => {
  const copied: string[] = [];
  const items = contextMenu(
    { linkURL: "https://x.test/a", selectionText: "", isEditable: false },
    { copyLink: (u) => copied.push(u), lookUp() {} },
  );
  const click = items[0]?.click as (() => void) | undefined;
  click?.();
  expect(copied).toEqual(["https://x.test/a"]);
});

import type { MenuItemConstructorOptions } from "electron";

// The Mac's own menus (#1857): the application menu bar and the right-click menu, as the
// owner picked from mockups (card d_acid-creek-health). Plain data, so a unit test reads them
// without Electron; main.ts hands it the app's actions.

export type AppMenuActions = {
  /** Settings… (⌘,): the page's Settings, or the server window while the page can't load. */
  settings(): void;
  /** Find… (⌘F): the page's Find box, as the / key. */
  find(): void;
  /** Starbridge Docs, in the browser. */
  docs(): void;
  /** Developer Tools stay in a development run; a release has none. */
  development: boolean;
};

export function appMenu(a: AppMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: "Starbridge",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Command+,", click: a.settings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [{ role: "close" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find…", accelerator: "Command+F", click: a.find },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(a.development ? ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[]) : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Starbridge Docs", click: a.docs }] },
  ];
}

/** What the right-click landed on, from Electron's `context-menu` event. */
export type Clicked = { linkURL: string; selectionText: string; isEditable: boolean };

export type ContextActions = {
  copyLink(url: string): void;
  lookUp(): void;
};

/** The right-click menu: Copy and Look Up on a selection, Copy Link on a link, the edit items in a field. */
export function contextMenu(c: Clicked, a: ContextActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[][] = [];
  if (c.isEditable) {
    items.push([{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }]);
  } else {
    const word = c.selectionText.trim();
    if (c.linkURL) items.push([{ label: "Copy Link", click: () => a.copyLink(c.linkURL) }]);
    if (word) {
      const shown = word.length > 24 ? `${word.slice(0, 24)}…` : word;
      items.push([{ role: "copy" }, { label: `Look Up “${shown}”`, click: a.lookUp }]);
      items.push([{ role: "selectAll" }]);
    }
  }
  return items.flatMap((group, i) =>
    i === 0 ? group : [{ type: "separator" } as MenuItemConstructorOptions, ...group],
  );
}

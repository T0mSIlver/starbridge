"use client";

import { useEffect, useRef } from "react";
import { setShortcuts } from "@/lib/shortcuts";
import { Icon } from "./icons";
import settings from "./Settings.module.css";
import s from "./Shortcuts.module.css";
import ui from "./ui.module.css";

/** Every shortcut the web binds, as the dialog lists it (#1889). */
const GROUPS: { name: string; note?: string; rows: [keys: string[], what: string][] }[] = [
  {
    name: "Move",
    rows: [
      [["J"], "Next card"],
      [["K"], "Previous card"],
    ],
  },
  {
    name: "Answer",
    note: "Needs a window 1100 px wide or more.",
    rows: [
      [["1", "2", "3", "4"], "Pick that option"],
      [["A"], "Allow a permission prompt"],
      [["D"], "Deny a permission prompt"],
    ],
  },
  {
    name: "Reply",
    rows: [
      [["Enter"], "Send"],
      [["Shift", "Enter"], "New line"],
    ],
  },
  { name: "Find", rows: [[["/"], "Jump to Find"]] },
  { name: "Help", rows: [[["?"], "Show this list"]] },
];

/** The list of shortcuts, a modal `<dialog>` like Settings' others: Esc and Back close it. */
export function ShortcutsDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      className={`m-rise ${settings.dialog} ${s.dialog}`}
      onClose={() => setShortcuts(false)}
      aria-labelledby="shortcuts-title"
    >
      <div className={s.head}>
        <h2 id="shortcuts-title" className="t-subtitle">
          Keyboard shortcuts
        </h2>
        <button
          type="button"
          className={`${ui.btn} ${ui.sm} ${ui.ghost}`}
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className={s.body}>
        {GROUPS.map((g) => (
          <section key={g.name} className={s.group} aria-label={g.name}>
            <h3 className={`t-action ${s.name}`}>{g.name}</h3>
            {g.note && <p className={`t-meta ${s.note}`}>{g.note}</p>}
            <ul className={s.list}>
              {g.rows.map(([keys, what]) => (
                <li key={what} className={s.item}>
                  <span className={s.keys}>
                    {keys.map((k) => (
                      <kbd key={k} className={`t-key ${s.kbd}`}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className={`t-small ${s.what}`}>{what}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  );
}

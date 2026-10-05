"use client";

import { useState } from "react";
import { setFind, useFind } from "@/lib/find";
import { Icon, Mark } from "./icons";
import s from "./PhoneBar.module.css";

/** A page's top bar under 600 px: the mark or a way back, the title, Find and the page's own action. */
export function PhoneBar({
  title,
  back,
  view,
  find = true,
}: {
  title: string;
  back?: () => void;
  view?: React.ReactNode;
  find?: boolean;
}) {
  const q = useFind();
  const [finding, setFinding] = useState(false);
  return (
    <header className={s.bar}>
      {back ? (
        <button type="button" className={s.icon} aria-label="Back" onClick={back}>
          <Icon name="back" size={22} />
        </button>
      ) : (
        <Mark size={20} />
      )}
      {finding ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: the owner just asked to type
          autoFocus
          className={`t-body ${s.input}`}
          aria-label="Find"
          placeholder="Find"
          value={q}
          onChange={(e) => setFind(e.target.value)}
          onBlur={() => !q && setFinding(false)}
        />
      ) : (
        <h1 className={`t-subtitle ${s.title}`}>{title}</h1>
      )}
      {find && !back && (
        <button
          type="button"
          className={s.icon}
          aria-label="Find"
          onClick={() => setFinding(!finding)}
        >
          <Icon name="search" size={22} />
        </button>
      )}
      {!back && view}
    </header>
  );
}

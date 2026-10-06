"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  always = false,
}: {
  title: string;
  back?: () => void;
  view?: React.ReactNode;
  find?: boolean;
  /** Shown at every width: the way back from an item opened in a narrow window. */
  always?: boolean;
}) {
  const q = useFind();
  const [finding, setFinding] = useState(false);
  // /sample mirrors the app in development (app/sample).
  const home = /^\/sample(?=\/|$)/.test(usePathname()) ? "/sample" : "/";
  return (
    <header className={`${s.bar} ${always ? s.always : ""}`}>
      {back ? (
        <button type="button" className={s.icon} aria-label="Back" onClick={back}>
          <Icon name="back" size={22} />
        </button>
      ) : (
        <Link href={home} className={s.home} aria-label="Starbridge, Inbox">
          <Mark size={20} />
        </Link>
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

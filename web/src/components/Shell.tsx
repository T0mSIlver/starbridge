"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { needsYou } from "@/lib/feed";
import { setFind, useFind } from "@/lib/find";
import { useApp } from "./AppProvider";
import { Icon, type IconName, Mark } from "./icons";
import s from "./Shell.module.css";
import ui from "./ui.module.css";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Inbox", icon: "inbox" },
  { href: "/quotas", label: "Quotas", icon: "gauge" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

type LaunchQueue = { setConsumer(fn: (p: { targetURL?: string }) => void): void };

/** The left rail from 600 px, the bottom bar below it (DESIGN.md, "The look"). */
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  // The installed app reuses its window (manifest.ts, launch_handler): open what was launched,
  // such as the Quotas shortcut, in it.
  useEffect(() => {
    (window as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(({ targetURL }) => {
      if (!targetURL) return;
      const url = new URL(targetURL);
      router.push(url.pathname + url.search);
    });
  }, [router]);
  const { inbox, prompts, boot, withheld } = useApp();
  const open = needsYou(inbox.items, prompts, Date.now()).length;
  const machines =
    boot.state === "ready"
      ? [...boot.ctx.dir.members.values()].filter((m) => m.member.role === "machine" && m.active)
          .length
      : 0;
  const q = useFind();
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      findRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // /sample mirrors the app in development (app/sample).
  const at = path.replace(/^\/sample(?=\/|$)/, "") || "/";
  const home = path.startsWith("/sample") ? "/sample" : "/";
  const tabs = TABS.map(({ href, label, icon }) => {
    const active = href === "/" ? at === "/" : at.startsWith(href);
    const count = href === "/" && open > 0 ? open : 0;
    return { href, label, icon, active, count };
  });

  return (
    <div className={s.frame}>
      <nav className={s.rail} aria-label="Main">
        <Link href={home} className={`t-action ${s.brand}`} aria-label="Starbridge, Inbox">
          <Mark size={20} />
          Starbridge
        </Link>
        <label className={`t-meta ${s.find}`}>
          <Icon name="search" size={16} />
          <input
            ref={findRef}
            className={s.findInput}
            placeholder="Find"
            aria-label="Find"
            value={q}
            onChange={(e) => {
              setFind(e.target.value);
              // Find filters the inbox: go there, staying inside /sample.
              if (at !== "/") router.push(path.startsWith("/sample") ? "/sample" : "/");
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setFind("");
              e.currentTarget.blur();
            }}
          />
          <kbd className={`t-key ${ui.kbd}`}>/</kbd>
        </label>
        <ul className={s.tabs}>
          {tabs.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className={`t-small ${s.tab}`}
                aria-current={t.active ? "page" : undefined}
              >
                <Icon name={t.icon} size={18} />
                <span className={s.label}>{t.label}</span>
                {t.count > 0 && (
                  <span className={`t-meta ${s.count}`}>
                    {t.count}
                    <span className="sr-only"> open</span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
        {machines > 0 && (
          <p className={`t-caption ${s.machines}`}>
            {machines} {machines === 1 ? "machine" : "machines"} paired
          </p>
        )}
      </nav>
      <main className={s.main}>
        {withheld && (
          <p className={`t-small ${ui.error} ${s.withheld}`} role="alert">
            {withheld}
          </p>
        )}
        {children}
      </main>
      <nav className={s.bottom} aria-label="Main">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`t-caption ${s.bottomTab}`}
            aria-current={t.active ? "page" : undefined}
          >
            <span className={s.bottomIcon}>
              <Icon name={t.icon} size={22} />
              {t.count > 0 && (
                <span className={`t-key ${s.badge}`} aria-hidden="true">
                  {t.count}
                </span>
              )}
            </span>
            {t.label}
            {t.count > 0 && <span className="sr-only">, {t.count} open</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}

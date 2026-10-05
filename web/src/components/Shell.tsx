"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { closedAt } from "@/lib/outcome";
import { useApp } from "./AppProvider";
import { DevicesIcon, GaugeIcon, InboxIcon, Mark } from "./icons";
import s from "./Shell.module.css";

const TABS = [
  { href: "/", label: "Inbox", Icon: InboxIcon },
  { href: "/quotas", label: "Quotas", Icon: GaugeIcon },
  { href: "/devices", label: "Devices", Icon: DevicesIcon },
];

type LaunchQueue = { setConsumer(fn: (p: { targetURL?: string }) => void): void };

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
  const open = useApp().inbox.items.filter((item) => !closedAt(item)).length;
  return (
    <div className={s.frame}>
      <nav className={s.nav} aria-label="Main">
        <div className={s.brand}>
          <span className={s.mark}>
            <Mark />
          </span>
          <span className={`t-heading ${s.name}`}>Starbridge</span>
        </div>
        <ul className={s.tabs}>
          {TABS.map(({ href, label, Icon }) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <li key={href}>
                <Link href={href} className={s.tab} aria-current={active ? "page" : undefined}>
                  <span className={s.icon}>
                    <Icon />
                    {href === "/" && open > 0 && (
                      <span className={s.badge} aria-hidden="true">
                        {open}
                      </span>
                    )}
                  </span>
                  <span>
                    {label}
                    {href === "/" && open > 0 && <span className="sr-only">, {open} open</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className={`${s.main} ${path === "/" ? s.wide : ""}`}>{children}</main>
    </div>
  );
}

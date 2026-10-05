"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { closedAt } from "@/lib/outcome";
import { useApp } from "./AppProvider";
import { DevicesIcon, GaugeIcon, InboxIcon, Mark } from "./icons";
import s from "./Shell.module.css";

const TABS = [
  { href: "/", label: "Inbox", Icon: InboxIcon },
  { href: "/quotas", label: "Quotas", Icon: GaugeIcon },
  { href: "/devices", label: "Devices", Icon: DevicesIcon },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
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

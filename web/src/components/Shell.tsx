"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDecisions } from "./DecisionsProvider";
import { DevicesIcon, GaugeIcon, InboxIcon, StarIcon } from "./icons";
import s from "./Shell.module.css";

const TABS = [
  { href: "/", label: "Inbox", Icon: InboxIcon },
  { href: "/quotas", label: "Quotas", Icon: GaugeIcon },
  { href: "/devices", label: "Devices", Icon: DevicesIcon },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const open = useDecisions().items.filter((d) => !d.answer).length;
  return (
    <div className={s.frame}>
      <nav className={s.nav} aria-label="Main">
        <div className={s.brand}>
          <span className={s.mark}>
            <StarIcon size={18} />
          </span>
          <span className="t-heading">Starbridge</span>
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
                      <span className={s.badge} aria-label={`${open} open`}>
                        {open}
                      </span>
                    )}
                  </span>
                  <span className={s.tabLabel}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className={s.main}>{children}</main>
    </div>
  );
}

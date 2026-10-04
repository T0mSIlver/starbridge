import type { Metadata } from "next";
import { QuotaCard } from "@/components/QuotaCard";
import ui from "@/components/ui.module.css";
import { quotas, takenAt } from "@/lib/fixtures/quotas";
import { relative } from "@/lib/format";
import s from "./quotas.module.css";

export const metadata: Metadata = { title: "Quotas" };

// Windows with an alert first, then the order the uploader sent.
export default function QuotasPage() {
  const sorted = [...quotas].sort((a, b) => Number(!!b.alert) - Number(!!a.alert));
  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Quotas</h1>
        <span className="t-small">Updated {relative(takenAt)}</span>
      </header>
      <ul className={`${ui.list} ${s.grid}`}>
        {sorted.map((q) => (
          <li key={`${q.provider}/${q.window.id}`}>
            <QuotaCard q={q} />
          </li>
        ))}
      </ul>
    </>
  );
}

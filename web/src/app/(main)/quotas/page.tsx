import type { Metadata } from "next";
import { QuotaCard } from "@/components/QuotaCard";
import { quotas, quotasUpdatedAt } from "@/lib/fixtures";
import { relative } from "@/lib/format";
import ui from "@/components/ui.module.css";
import s from "./quotas.module.css";

export const metadata: Metadata = { title: "Quotas" };

// Windows with an alert first, then the order the uploader sent.
export default function QuotasPage() {
  const sorted = [...quotas].sort((a, b) => Number(!!b.alert) - Number(!!a.alert));
  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Quotas</h1>
        <span className="t-small">Updated {relative(quotasUpdatedAt)}</span>
      </header>
      <ul className={`${ui.list} ${s.grid}`}>
        {sorted.map((q) => (
          <li key={q.id}>
            <QuotaCard q={q} />
          </li>
        ))}
      </ul>
    </>
  );
}

import type { Metadata } from "next";
import { Quotas } from "@/components/Quotas";
import s from "./quotas.module.css";

export const metadata: Metadata = { title: "Quotas" };

export default function QuotasPage() {
  return <Quotas gridClass={s.grid} />;
}

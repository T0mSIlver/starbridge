import type { Metadata } from "next";
import { Quotas } from "@/components/Quotas";

export const metadata: Metadata = { title: "Quotas" };

export default function QuotasPage() {
  return <Quotas />;
}

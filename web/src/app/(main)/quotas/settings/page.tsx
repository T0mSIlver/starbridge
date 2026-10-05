import type { Metadata } from "next";
import { QuotaSettingsForm } from "@/components/QuotaSettings";

export const metadata: Metadata = { title: "Quota settings" };

export default function QuotaSettingsPage() {
  return <QuotaSettingsForm />;
}

import type { Metadata } from "next";
import { Devices } from "@/components/Devices";
import { QuotaSettingsForm } from "@/components/QuotaSettings";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div style={{ maxWidth: "var(--size-content)", padding: "var(--s10)" }}>
      <QuotaSettingsForm />
      <div style={{ height: "var(--s10)" }} />
      <Devices />
    </div>
  );
}

"use client";

import { notFound } from "next/navigation";
import { Quotas } from "@/components/Quotas";
import { SampleProvider } from "@/components/SampleProvider";
import { Shell } from "@/components/Shell";

// Quotas on a device that just joined (#661), for comparing screenshots in development only.
export default function SampleQuotasEmpty() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider noQuotas>
      <Shell>
        <Quotas />
      </Shell>
    </SampleProvider>
  );
}

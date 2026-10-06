"use client";

import { notFound } from "next/navigation";
import { Inbox } from "@/components/Inbox";
import { SampleProvider } from "@/components/SampleProvider";
import { Shell } from "@/components/Shell";

// A new account's inbox (no machine yet), for comparing screenshots in development only.
export default function SampleEmpty() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider empty>
      <Shell>
        <Inbox />
      </Shell>
    </SampleProvider>
  );
}

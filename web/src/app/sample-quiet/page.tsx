"use client";

import { notFound } from "next/navigation";
import { Inbox } from "@/components/Inbox";
import { SampleProvider } from "@/components/SampleProvider";
import { Shell } from "@/components/Shell";

// The inbox with nothing open (#662), for comparing screenshots in development only.
export default function SampleQuiet() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider quiet>
      <Shell>
        <Inbox />
      </Shell>
    </SampleProvider>
  );
}

"use client";

import { notFound } from "next/navigation";
import { Landing } from "@/components/Landing";

// The landing page alone, for comparing screenshots in development only.
export default function SampleLanding() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Landing onOwnerToken={() => {}} />;
}

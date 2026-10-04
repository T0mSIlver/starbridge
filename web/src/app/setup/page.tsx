import type { Metadata } from "next";
import { Setup } from "@/components/Setup";
import { recoveryWords } from "@/lib/fixtures";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  return <Setup account="T0mSIlver" device="Firefox on Mac" words={recoveryWords} />;
}

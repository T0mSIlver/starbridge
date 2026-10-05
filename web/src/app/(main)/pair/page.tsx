import type { Metadata } from "next";
import { Devices } from "@/components/Devices";

export const metadata: Metadata = { title: "Pair" };

/** Opened from a `starbridge pair` link: the code after `#` is filled in and checked. */
export default function PairPage() {
  return <Devices />;
}

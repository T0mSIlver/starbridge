import type { Metadata } from "next";
import { AddDevice } from "@/components/AddDevice";

export const metadata: Metadata = { title: "Pair" };

/** Opened from a `starbridge pair` link: the code after `#` is filled in and checked. */
export default function PairPage() {
  return <AddDevice />;
}

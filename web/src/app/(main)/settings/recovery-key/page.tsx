import type { Metadata } from "next";
import { ReplaceRecoveryKey } from "@/components/RecoveryKey";

export const metadata: Metadata = { title: "Recovery key" };

export default function RecoveryKeyPage() {
  return <ReplaceRecoveryKey />;
}

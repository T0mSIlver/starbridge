import type { Metadata } from "next";
import { Devices } from "@/components/Devices";
import { devices, machines } from "@/lib/fixtures";

export const metadata: Metadata = { title: "Devices" };

export default function DevicesPage() {
  return <Devices devices={devices} machines={machines} />;
}

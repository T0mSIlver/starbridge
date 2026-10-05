import type { Metadata } from "next";
import { AddDevice } from "@/components/AddDevice";

export const metadata: Metadata = { title: "Add a device" };

export default function AddDevicePage() {
  return <AddDevice />;
}

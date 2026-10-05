import type { Metadata } from "next";
import { PromptLog } from "@/components/Prompts";

export const metadata: Metadata = { title: "Prompts" };

export default function PromptsPage() {
  return <PromptLog />;
}

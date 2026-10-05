import type { Metadata } from "next";
import { FirstRunPage } from "@/components/Setup";
import ui from "@/components/ui.module.css";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <FirstRunPage>
      <h1 className="t-heading">Page not found</h1>
      <a href="/" className={`t-label ${ui.btn} ${ui.lg} ${ui.fill}`}>
        Open Starbridge
      </a>
    </FirstRunPage>
  );
}

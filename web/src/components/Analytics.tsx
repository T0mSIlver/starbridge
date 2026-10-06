"use client";

import Script from "next/script";
import { analyticsOn, SCRIPT, track, WEBSITE_ID } from "@/lib/analytics";

/**
 * Loads Umami on a public page and records its view. Auto-tracking is off so the tracker
 * never follows the app's client-side navigation once someone signs in from the landing page.
 * Nothing on a build without analytics.
 */
export function Analytics() {
  if (!analyticsOn()) return null;
  return (
    <Script
      src={SCRIPT}
      data-website-id={WEBSITE_ID}
      data-auto-track="false"
      data-do-not-track="true"
      data-exclude-search="true"
      data-exclude-hash="true"
      onReady={() => track()}
    />
  );
}

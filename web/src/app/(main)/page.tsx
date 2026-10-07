import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Inbox } from "@/components/Inbox";
import { landingMetadata, origin, SESSION_COOKIE } from "@/lib/landing";

// A visitor gets the landing page here (Gate), so its HTML carries the landing page's title and
// link preview; a signed-in browser's tab says Inbox.
export async function generateMetadata(): Promise<Metadata> {
  if ((await cookies()).has(SESSION_COOKIE)) return { title: "Inbox" };
  return landingMetadata(origin(await headers()));
}

export default function InboxPage() {
  return <Inbox />;
}

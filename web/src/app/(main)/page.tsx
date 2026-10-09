import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Inbox } from "@/components/Inbox";
import { DESKTOP_COOKIE, landingMetadata, origin, SESSION_COOKIE } from "@/lib/landing";

// A visitor gets the landing page here (Gate), so its HTML carries the landing page's title and
// link preview; a signed-in browser's tab says Inbox, and the desktop app's sign-in says so (#905).
export async function generateMetadata(): Promise<Metadata> {
  const jar = await cookies();
  if (jar.has(SESSION_COOKIE)) return { title: "Inbox" };
  if (jar.has(DESKTOP_COOKIE)) return { title: "Sign in" };
  return landingMetadata(origin(await headers()));
}

export default function InboxPage() {
  return <Inbox />;
}

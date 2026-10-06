import type { Metadata } from "next";
import { FirstRunPage } from "@/components/Setup";
import s from "@/components/Setup.module.css";
import ui from "@/components/ui.module.css";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

/**
 * Where GitHub sign-in ends for the Android app on starbridge.run: an App Link that the verified
 * app opens without this page (PROTOCOL.md, "Auth"). Where it can't, a tap here hands the
 * one-time code to the app; Chrome asks before following starbridge:// without one. No analytics
 * here: the URL holds the code.
 */
export default async function AppSignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await searchParams;
  return (
    <FirstRunPage>
      {typeof code === "string" && code ? (
        <>
          <h1 className="t-heading">Back to the app</h1>
          <p className={`t-small ${s.lede}`}>You signed in with GitHub. Finish in the app.</p>
          <a
            href={`starbridge://auth?code=${encodeURIComponent(code)}`}
            className={`t-label ${ui.btn} ${ui.lg} ${ui.fill}`}
          >
            Open Starbridge
          </a>
        </>
      ) : (
        <>
          <h1 className="t-heading">Sign-in link incomplete</h1>
          <p className={`t-small ${s.lede}`}>Start signing in again from the app.</p>
        </>
      )}
    </FirstRunPage>
  );
}

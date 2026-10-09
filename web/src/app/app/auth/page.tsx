import type { Metadata } from "next";
import { AppHandOff } from "@/components/AppHandOff";
import { FirstRunPage } from "@/components/Setup";
import s from "@/components/Setup.module.css";
import ui from "@/components/ui.module.css";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

/**
 * Where the browser hands GitHub sign-in on to the Android app on starbridge.run: an App Link
 * that the verified app opens without this page (PROTOCOL.md, "Auth"). Where it can't, a tap here
 * passes GitHub's code to the app; Chrome asks before following starbridge:// without one. The
 * code is worthless without the app's verifier, but no analytics here all the same.
 */
export default async function AppSignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code, error, state } = await searchParams;
  const word = (v: unknown): v is string => typeof v === "string" && v !== "";
  // GitHub's code, or its error when the owner turned it down, goes on to the app with the state.
  const passed: Record<string, string> | undefined = word(code)
    ? { code, ...(word(state) && { state }) }
    : word(error) && word(state)
      ? { error, state }
      : undefined;
  return (
    <FirstRunPage>
      {passed ? (
        <>
          <h1 className="t-heading">
            {"code" in passed ? "Back to the app" : "Sign-in didn't finish"}
          </h1>
          <p className={`t-small ${s.lede}`}>
            {"code" in passed
              ? "You signed in with GitHub. Finish in the app."
              : "GitHub didn't sign you in. Try again from the app."}
          </p>
          <a
            href={`starbridge://auth?${new URLSearchParams(passed)}`}
            className={`t-label ${ui.btn} ${ui.lg} ${ui.fill}`}
          >
            Open Starbridge
          </a>
          {"code" in passed && passed.state && <AppHandOff state={passed.state} />}
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

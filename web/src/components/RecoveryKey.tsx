"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { NewRecoveryKey, RecoveryEntry } from "@/lib/device";
import { useApp, useDevice } from "./AppProvider";
import p from "./Pairing.module.css";
import { PhoneBar } from "./PhoneBar";
import s from "./Settings.module.css";
import k from "./Setup.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Replaces the recovery key (#348), with the current one: both sign, so neither a stolen device
 * nor a leaked key replaces it alone. The new key is shown before anything is posted.
 */
export function ReplaceRecoveryKey() {
  const ctx = useDevice();
  const { update } = useApp();
  const [typedKey, setTypedKey] = useState("");
  const [typed, setTyped] = useState<RecoveryEntry>({ complete: false, status: "" });
  const [made, setMade] = useState<NewRecoveryKey>();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    load().then((d) => live && setTyped(d.readRecoveryEntry(typedKey)));
    return () => {
      live = false;
    };
  }, [typedKey]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    run(async () => setMade(await (await load()).prepareRecoveryKey(ctx, typedKey)));

  return (
    <>
      <PhoneBar title="Recovery key" find={false} />
      <div className={s.page}>
        <div>
          <nav className={`t-small ${p.crumbs}`} aria-label="Breadcrumb">
            <Link href="/settings">Settings</Link> / Devices
          </nav>
          <h1 className={`t-heading ${s.title}`}>
            {done
              ? "Recovery key replaced"
              : made
                ? "Save your new recovery key"
                : "Replace the recovery key"}
          </h1>
        </div>
        <div className={k.column}>
          {done ? (
            <>
              <p className={`t-small ${k.lede}`}>
                The old key no longer works. Your devices are not affected.
              </p>
              <Link href="/settings" className={`t-label ${ui.btn} ${ui.rec}`}>
                Back to Devices
              </Link>
            </>
          ) : made ? (
            <>
              <p className={`t-small ${k.lede}`}>The old key works until you save this one.</p>
              <p className={`t-snippet ${k.key}`} data-testid="new-recovery-key">
                {made.recoveryKey.split("-").map((group, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity
                  <span key={i}>{group}</span>
                ))}
              </p>
              <button
                type="button"
                className={`t-label ${ui.btn}`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(made.recoveryKey);
                    setCopied(true);
                  } catch {
                    // The key stays on screen to write down.
                  }
                }}
              >
                {copied ? "Copied" : "Copy the key"}
              </button>
              <label className={`t-small ${k.confirm}`}>
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                <span>I wrote this key down somewhere safe, away from this device.</span>
              </label>
              <button
                type="button"
                className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${k.go}`}
                disabled={!saved || busy}
                onClick={() =>
                  run(async () => {
                    update(await made.replace());
                    setDone(true);
                  })
                }
              >
                {busy ? "Saving…" : error ? "Try again" : "Save the new key"}
              </button>
            </>
          ) : (
            <form
              className={k.column}
              onSubmit={(e) => {
                e.preventDefault();
                make();
              }}
            >
              <p className={`t-small ${k.lede}`}>
                You get a new key to write down. Once it is saved, the old key stops working. Your
                devices are not affected.
              </p>
              <label className={`t-meta ${k.dim}`} htmlFor="current-recovery-key">
                Your current recovery key
              </label>
              <textarea
                id="current-recovery-key"
                className={`t-snippet ${k.input}`}
                rows={2}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="current-recovery-key-check"
                value={typedKey}
                onChange={(e) => setTypedKey(e.target.value)}
              />
              <p
                id="current-recovery-key-check"
                className={`t-meta ${typed.problem ? k.error : k.dim}`}
                aria-live="polite"
              >
                {typed.problem ?? typed.status}
              </p>
              <button
                type="submit"
                className={`t-label ${ui.btn} ${ui.fill}`}
                disabled={busy || !typed.complete}
              >
                Make a new key
              </button>
              <p className={`t-meta ${k.dim}`}>
                Lost it? Without the current key it can't be replaced. Your devices keep working.
              </p>
            </form>
          )}
          {error && (
            <p className={`t-small ${k.error}`} role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

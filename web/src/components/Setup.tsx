"use client";

import { useState } from "react";
import { desktop } from "@/lib/desktop";
import { Mark } from "./icons";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

// First-device setup: the recovery key is shown here once and never again
// (spec/keys-and-trust.md), with the name this device signs into the account (#2139).
export function Setup({
  name,
  onName,
  recoveryKey,
  unsaved,
  onContinue,
}: {
  name: string;
  onName: (name: string) => void;
  recoveryKey: string;
  /** A page closed before its key was saved: this key is a new one. */
  unsaved: boolean;
  /** Signs and posts the account's first entry: until it succeeds, a reload shows a new key. */
  onContinue: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The first try signs the name in, and a retry posts that same entry: the name is set then.
  const [tried, setTried] = useState(false);

  const proceed = async () => {
    setBusy(true);
    setTried(true);
    setError(undefined);
    try {
      await onContinue();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      // The key stays on screen to write down.
    }
  };

  return (
    <FirstRunPage>
      <h1 className="t-heading">Save your recovery key</h1>
      <p className={`t-small ${s.lede}`}>
        {unsaved && "The page closed before you saved the last key, so that key was never used. "}
        Keep this key in a password manager or on paper. If you lose every device, it adds a new
        one. This is the only time it is shown.
      </p>
      <p className={`t-snippet ${s.key}`} data-testid="recovery-key">
        {recoveryKey.split("-").map((group, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity
          <span key={i}>{group}</span>
        ))}
      </p>
      <button type="button" className={`t-label ${ui.btn}`} onClick={copy}>
        {copied ? "Copied" : "Copy the key"}
      </button>
      <NameField value={name} onChange={onName} disabled={tried} />
      <label className={`t-small ${s.confirm}`}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I stored this key</span>
      </label>
      <button
        type="button"
        className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${s.go}`}
        disabled={!saved || busy || !name.trim()}
        onClick={proceed}
      >
        {busy ? "Creating the account…" : error ? "Try again" : "Create the account"}
      </button>
      {error && (
        <p className={`t-small ${s.error}`} role="alert">
          {error}
        </p>
      )}
    </FirstRunPage>
  );
}

/** This device's name in the account, prefilled with its browser or app (Gate.tsx). */
export function NameField({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={s.field}>
      <label className={`t-meta ${s.dim}`} htmlFor="device-name">
        {desktop ? "Name this app" : "Name this browser"}
      </label>
      <input
        id="device-name"
        className={`t-body ${s.input}`}
        value={value}
        maxLength={100}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** The frame of every first-run screen. */
export function FirstRunPage({
  children,
  centered = false,
}: {
  children: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <div className={s.frame}>
      <header className={s.top}>
        <a href="/" className={`t-action ${s.brand}`}>
          <Mark size={20} />
          Starbridge
        </a>
      </header>
      <main className={s.center}>
        <div className={centered ? `${s.column} ${s.centered}` : s.column}>{children}</div>
      </main>
      <nav className={`t-meta ${s.foot}`} aria-label="Legal">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="https://github.com/T0mSIlver/starbridge">Source on GitHub</a>
      </nav>
    </div>
  );
}

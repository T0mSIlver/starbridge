"use client";

import { useState } from "react";
import { Mark } from "./icons";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

// First-device setup: the recovery key is shown here once and never again
// (SPEC.md, "Keys and trust").
export function Setup({
  device,
  recoveryKey,
  onContinue,
}: {
  device: string;
  recoveryKey: string;
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

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
      <p className={`t-meta ${s.dim}`}>First device: {device}</p>
      <h1 className="t-heading">Save your recovery key</h1>
      <p className={`t-small ${s.lede}`}>
        This key adds a new device if you lose every device. Starbridge shows it once.
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
      <label className={`t-small ${s.confirm}`}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I wrote this key down somewhere safe, away from this device.</span>
      </label>
      <button
        type="button"
        className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${s.go}`}
        disabled={!saved}
        onClick={onContinue}
      >
        Continue
      </button>
    </FirstRunPage>
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
      <a href="/" className={`t-action ${s.brand}`}>
        <Mark size={20} />
        Starbridge
      </a>
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

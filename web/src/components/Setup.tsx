"use client";

import { useState } from "react";
import { Mark } from "./icons";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

// First-device setup: the recovery key is shown here once and never again
// (SPEC.md, "Keys and trust").
export function Setup({
  device,
  words,
  onContinue,
}: {
  device: string;
  words: string[];
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(words.join(" "));
      setCopied(true);
    } catch {
      // The words stay on screen to write down.
    }
  };

  return (
    <FirstRunPage>
      <p className={`t-meta ${s.dim}`}>First device: {device}</p>
      <h1 className="t-heading">Save your recovery key</h1>
      <p className={`t-small ${s.lede}`}>
        These 24 words approve a new device if you lose every device. Starbridge shows them once.
      </p>
      <ol className={s.words}>
        {words.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a word list may repeat a word; its position is its identity
          <li key={i} className="t-small">
            <span className={`t-meta ${s.n}`}>{i + 1}</span>
            <span>{w}</span>
          </li>
        ))}
      </ol>
      <button type="button" className={`t-label ${ui.btn}`} onClick={copy}>
        {copied ? "Copied" : "Copy words"}
      </button>
      <label className={`t-small ${s.confirm}`}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I wrote these words down somewhere safe, away from this device.</span>
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
export function FirstRunPage({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.frame}>
      <a href="/" className={`t-action ${s.brand}`}>
        <Mark size={20} />
        Starbridge
      </a>
      <main className={s.center}>
        <div className={s.column}>{children}</div>
      </main>
      <nav className={`t-meta ${s.foot}`} aria-label="Legal">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="https://github.com/T0mSIlver/starbridge">Source on GitHub</a>
      </nav>
    </div>
  );
}

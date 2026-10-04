"use client";

import { useState } from "react";
import { StarIcon } from "./icons";
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
    <main className={s.page}>
      <div className={s.brand}>
        <span className={s.mark}>
          <StarIcon size={18} />
        </span>
        <span className="t-heading">Starbridge</span>
      </div>
      <p className={`t-label ${s.step}`}>First device: {device}</p>
      <h1 className="t-title">Save your recovery key</h1>
      <p className={s.lede}>
        These 24 words can approve a new device if you lose every device you have. This is the only
        time Starbridge shows them; the server never sees them.
      </p>
      <ol className={s.words}>
        {words.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a word list may repeat a word; its position is its identity
          <li key={i}>
            <span className={`t-machine ${s.n}`}>{i + 1}</span>
            <span className={s.word}>{w}</span>
          </li>
        ))}
      </ol>
      <button type="button" className={`${ui.button} ${s.copy}`} onClick={copy}>
        {copied ? "Copied" : "Copy words"}
      </button>
      <label className={s.confirm}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I wrote these words down somewhere safe, away from this device.</span>
      </label>
      <button
        type="button"
        className={`${ui.button} ${ui.primary} ${s.go}`}
        disabled={!saved}
        onClick={onContinue}
      >
        Continue
      </button>
    </main>
  );
}

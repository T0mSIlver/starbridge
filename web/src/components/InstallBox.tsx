"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";
import s from "./InstallBox.module.css";
import { Icon } from "./icons";

/** Label, command, and the method the copy event reports, kept as first named. */
const INSTALL = [
  ["macOS / Linux", "curl -fsSL https://starbridge.run/install.sh | sh", "Script"],
  ["Homebrew", "brew install T0mSIlver/starbridge/starbridge", "Homebrew"],
  ["npm", "npm i -g starbridge", "npm"],
] as const;

/**
 * The install commands by method, with a copy button. `counted`: copies go to analytics, which
 * only the landing page loads (lib/analytics.ts); the signed-in inbox shows the box too (#610).
 */
export function InstallBox({ counted = false }: { counted?: boolean }) {
  const [at, setAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [, cmd, method] = INSTALL[at] ?? ["", "", ""];
  const onCopied = () => {
    if (counted) track("copy-install", { method });
  };
  return (
    <div className={s.install}>
      <div className={`t-meta ${s.tabs}`} role="tablist" aria-label="Install with">
        {INSTALL.map(([label], i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === at}
            className={s.tab}
            onClick={() => {
              setAt(i);
              setCopied(false);
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={s.copy}
          aria-label={copied ? "Copied" : "Copy the install command"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              setCopied(true);
              onCopied();
            } catch {}
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={16} />
        </button>
        <span className="sr-only" role="status">
          {copied ? "Copied" : ""}
        </span>
      </div>
      <pre className={`t-code ${s.cmd}`} role="tabpanel" onCopy={onCopied}>
        {cmd}
      </pre>
    </div>
  );
}

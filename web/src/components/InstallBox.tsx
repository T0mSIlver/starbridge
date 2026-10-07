"use client";

import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import s from "./InstallBox.module.css";
import { Icon } from "./icons";

/**
 * Each platform's ways to install: label, command, and the method the copy event reports, kept
 * as first named. npm is the same package on both.
 */
const INSTALL = [
  {
    platform: "macOS / Linux",
    methods: [
      ["Script", "curl -fsSL https://starbridge.run/install.sh | sh", "Script"],
      ["Homebrew", "brew install T0mSIlver/starbridge/starbridge", "Homebrew"],
      ["npm", "npm i -g starbridge", "npm"],
    ],
  },
  {
    platform: "Windows",
    methods: [
      ["PowerShell", "irm https://starbridge.run/install.ps1 | iex", "Windows"],
      ["npm", "npm i -g starbridge", "npm"],
    ],
  },
] as const;

/**
 * The install commands by platform and method, with a copy button. `counted`: copies go to
 * analytics, which only the landing page loads (lib/analytics.ts); the signed-in inbox shows the
 * box too (#610).
 */
export function InstallBox({ counted = false }: { counted?: boolean }) {
  const [at, setAt] = useState(0);
  const [way, setWay] = useState(0);
  const [copied, setCopied] = useState(false);
  // The check shows for 2 s after a copy; another copy restarts it.
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const platform = INSTALL[at] ?? INSTALL[0];
  const [, cmd, method] = platform.methods[way] ?? platform.methods[0];
  const onCopied = () => {
    if (counted) track("copy-install", { method });
  };
  return (
    <div className={s.install}>
      <div className={`t-meta ${s.tabs}`} role="tablist" aria-label="Install on">
        {INSTALL.map(({ platform: label }, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === at}
            className={s.tab}
            onClick={() => {
              setAt(i);
              setWay(0);
              setCopied(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={`t-meta ${s.methods}`} role="tablist" aria-label="Install with">
        {platform.methods.map(([label], i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === way}
            className={s.method}
            onClick={() => {
              setWay(i);
              setCopied(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {/* The command scrolls sideways in its own box; the copy button stays at the line's end. */}
      <div className={s.line}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a command wider than the box scrolls, and keyboards scroll what they can focus. */}
        <pre className={`t-code ${s.cmd}`} role="tabpanel" tabIndex={0} onCopy={onCopied}>
          {cmd}
        </pre>
        <button
          type="button"
          className={s.copy}
          aria-label={copied ? "Copied" : "Copy the install command"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              setCopied(true);
              clearTimeout(reset.current);
              reset.current = setTimeout(() => setCopied(false), 2000);
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
    </div>
  );
}

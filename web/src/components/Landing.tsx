"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";
import { AGENTS_GUIDE, REPO, SELF_HOST } from "@/lib/links";
import { Analytics } from "./Analytics";
import { Icon, Mark } from "./icons";
import s from "./Landing.module.css";
import ui from "./ui.module.css";

// Product shots in public/landing, at 1.5x for the web inbox and 2x for the phones:
//   web-inbox-*      the app at /sample-hero (development only), 1440 by 900, after a click
//                    on the question with images
//   android-inbox-*, android-question-*  Roborazzi shots of the app: `inbox-landing`, `sheet-pick`
//   android-lock-*   the design v2 mockups' lock screen, which Roborazzi cannot render
// Each comes dark and light; `<picture>` picks the one the browser asks for.
function Shot({
  name,
  alt,
  width,
  height,
  className,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  // Dark is the default where the browser reports no preference (DESIGN.md, "Rules").
  return (
    <picture>
      <source media="(prefers-color-scheme: light)" srcSet={`/landing/${name}-light.webp`} />
      <img
        className={className}
        src={`/landing/${name}-dark.webp`}
        alt={alt}
        width={width}
        height={height}
      />
    </picture>
  );
}

function Phone({ name, alt }: { name: string; alt: string }) {
  return (
    <div className={s.phone}>
      <Shot name={name} alt={alt} width={824} height={1784} className={s.phoneScreen} />
    </div>
  );
}

const FEATURES = [
  ["Questions", "Decide from anywhere. Your tap becomes the agent's next prompt."],
  ["Runs", "Builds, releases and heavy jobs stay on your lock screen until they end."],
  [
    "Quotas",
    "What's left on each AI plan, from CodexBar, with an optional alert before a window runs out.",
  ],
  ["Permission prompts", "Allow or deny a command away from the keyboard. Off by default."],
] as const;

const INSTALL = [
  ["Script", "curl -fsSL https://starbridge.run/install.sh | sh"],
  ["Homebrew", "brew install T0mSIlver/starbridge/starbridge"],
  ["npm", "npm i -g starbridge"],
] as const;

function Install() {
  const [at, setAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [method, cmd] = INSTALL[at] ?? ["", ""];
  const onCopied = () => track("copy-install", { method });
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
          aria-label={copied ? "Copied" : "Copy"}
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
      </div>
      <pre className={`t-code ${s.cmd}`} role="tabpanel" onCopy={onCopied}>
        {cmd}
      </pre>
    </div>
  );
}

function Section({
  title,
  text,
  flip,
  children,
}: {
  title: string;
  text: string;
  flip?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`${s.section} ${flip ? s.flip : ""}`}>
      <div className={s.sectionText}>
        <h2 className="t-title">{title}</h2>
        <p className={`t-prose ${s.dim}`}>{text}</p>
      </div>
      <div className={s.box}>{children}</div>
    </section>
  );
}

/** What a visitor without a device on this browser sees at `/` (design v2, direction B). */
export function Landing({ onOwnerToken }: { onOwnerToken: () => void }) {
  return (
    <div className={s.page}>
      <Analytics />
      <header className={`t-small ${s.top}`}>
        <a href="/" className={`t-subtitle ${s.brand}`}>
          <Mark size={22} />
          Starbridge
        </a>
        <nav className={s.nav} aria-label="Site">
          <a href="#features">Features</a>
          <a href="/docs">Docs</a>
          <a href={SELF_HOST}>Self-host</a>
          <a href={REPO}>GitHub</a>
        </nav>
        <a href="/v1/auth/github" className={`t-label ${ui.btn} ${ui.fill} ${s.signIn}`}>
          Sign in
        </a>
      </header>

      <section className={s.hero}>
        <h1 className="t-hero">
          Your agents ask.
          <br />
          You answer from anywhere.
        </h1>
        <p className={`t-lead ${s.dim} ${s.lead}`}>
          Answer your coding agents with one tap
          <span className={s.wideOnly}> on your phone or in a browser</span>, and the waiting
          session carries on. You also follow the runs that affect you until they pass or fail.
        </p>
        <div className={s.actions}>
          <a href="/v1/auth/github" className={`t-action ${ui.btn} ${ui.lg} ${ui.fill}`}>
            <Icon name="github" size={18} />
            Sign in with GitHub
          </a>
          <a href="#install" className={`t-action ${ui.btn} ${ui.lg}`}>
            Install the CLI
          </a>
        </div>
        <p className={`t-meta ${s.faint} ${s.wideOnly}`}>
          Open source, MIT · end-to-end encrypted · self-host or use starbridge.run
        </p>
      </section>

      <div className={s.showcase}>
        <div className={s.glow} aria-hidden="true" />
        <div className={s.browser}>
          <div className={s.chrome} aria-hidden="true">
            <i />
            <i />
            <i />
            <span className="t-caption">starbridge.run</span>
          </div>
          <Shot
            name="web-inbox"
            alt="The web inbox: a question with two images open beside the list, quota windows on the right"
            width={2160}
            height={1350}
            className={s.browserShot}
          />
        </div>
        <div className={s.heroPhone}>
          <Phone name="android-inbox" alt="The Android inbox with runs and questions" />
        </div>
      </div>

      <div id="features" className={s.features}>
        {FEATURES.map(([title, text]) => (
          <div key={title} className={s.feature}>
            <h3 className="t-prose">{title}</h3>
            <p className={`t-reading ${s.dim}`}>{text}</p>
          </div>
        ))}
      </div>

      <Section
        title="Answer in one tap, from anywhere"
        text="An agent asks for a decision that is yours and works on something else meanwhile. Your answer lands in its session as the next prompt, so the work goes on while you are away from the terminal."
      >
        <div className={s.crop}>
          <Phone name="android-question" alt="A question with two images in Android's sheet" />
        </div>
      </Section>

      <Section
        flip
        title="Follow the runs that affect you"
        text="A release, an eval, heavy work on the machine you are using. When an agent starts something that affects you, it says why, and the progress stays on your lock screen until it passes or fails."
      >
        <div className={s.lock}>
          <Shot
            name="android-lock"
            alt="The lock screen with a run's progress and a waiting prompt"
            width={824}
            height={1784}
          />
        </div>
      </Section>

      <section id="install" className={s.installSection}>
        <h2 className="t-title">Install on each machine that runs agents</h2>
        <p className={`t-prose ${s.dim} ${s.wideOnly}`}>
          <code>starbridge setup</code> pairs the machine and installs the Claude Code plugin. The
          script runs it; after Homebrew or npm, run it yourself.
        </p>
        <Install />
        <p className={`t-meta ${s.faint}`}>
          Works best with Claude Code; Codex, Pi and opencode supported.
        </p>
      </section>

      <footer className={`t-small ${s.foot}`}>
        <div className={s.footBrand}>
          <span className={`t-action ${s.brand}`}>
            <Mark size={20} />
            Starbridge
          </span>
          <span className={s.dim}>
            Only your own phone, browsers and machines can read your questions, answers and quotas.
            The server cannot.
          </span>
        </div>
        <div className={s.footCol}>
          <span>Product</span>
          <a href="#features">Questions</a>
          <a href="#features">Runs</a>
          <a href="#features">Quotas</a>
          <a href="#features">Permission prompts</a>
        </div>
        <div className={s.footCol}>
          <span>Source</span>
          <a href={REPO}>GitHub, MIT licence</a>
          <a href={SELF_HOST}>Self-host</a>
          <button type="button" className={s.textButton} onClick={onOwnerToken}>
            Use your own server
          </button>
          <a href={AGENTS_GUIDE}>How to tell your agents</a>
          <a href={`${REPO}/releases`}>Changelog</a>
        </div>
        <div className={s.footCol}>
          <span>Legal</span>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </div>
        <nav className={s.footInline} aria-label="Links">
          <a href={REPO}>GitHub</a>
          <a href={SELF_HOST}>Self-host</a>
          <a href={AGENTS_GUIDE}>How to tell your agents</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}

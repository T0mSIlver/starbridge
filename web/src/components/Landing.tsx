"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";
import { AGENTS_GUIDE, REPO, SELF_HOST } from "@/lib/links";
import { DEFAULT_SETTINGS, groups } from "@/lib/quotaSettings";
import { sample } from "@/lib/sample";
import { Analytics } from "./Analytics";
import { Icon, Mark } from "./icons";
import s from "./Landing.module.css";
import { QuotaGroup } from "./QuotaRow";
import ui from "./ui.module.css";

// Product shots in public/landing, at 1.5x for the web inbox and 2x for the phones:
//   web-inbox-*      the app at /sample-hero (development only), 1440 by 900, after a click
//                    on the question with images
//   android-*        the design v2 mockups' Android inbox, question sheet and lock screen
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
  ["Questions", "An agent asks, with code or images. Your tap becomes its next prompt."],
  ["Runs", "Long commands that need you at the machine, live on your lock screen."],
  ["Quota windows", "Every plan's limits on one screen, read from CodexBar."],
  ["Permission prompts", "Off unless you turn them on: the exact command, Allow or Deny."],
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
  short,
  flip,
  children,
}: {
  title: string;
  text: string;
  /** The text on phones, when shorter. */
  short?: string;
  flip?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`${s.section} ${flip ? s.flip : ""}`}>
      <div className={s.sectionText}>
        <h2 className="t-title">{title}</h2>
        <p className={`t-prose ${s.dim} ${short ? s.wideOnly : ""}`}>{text}</p>
        {short && <p className={`t-prose ${s.dim} ${s.narrowOnly}`}>{short}</p>}
      </div>
      <div className={s.box}>{children}</div>
    </section>
  );
}

/** What a visitor without a device on this browser sees at `/` (design v2, direction B). */
export function Landing({ onOwnerToken }: { onOwnerToken: () => void }) {
  const [quotas] = useState(() => sample().quotas.cards.slice(0, 4));
  const now = new Date();
  return (
    <div className={s.page}>
      <Analytics />
      <header className={`t-small ${s.top}`}>
        <span className={`t-subtitle ${s.brand}`}>
          <Mark size={22} />
          Starbridge
        </span>
        <nav className={s.nav} aria-label="Site">
          <a href="#features">Features</a>
          <a href={`${REPO}/tree/main/docs`}>Docs</a>
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
          Questions from every coding agent, with their code and images, answered with one tap
          <span className={s.wideOnly}> and pushed back into the session</span>. Runs and quota
          windows on the same screen.
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
          <Phone name="android-inbox" alt="The Android inbox with a run, a prompt and questions" />
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
        title="See which window runs out first"
        text="Each window fills in its provider's colour, with a tick where a steady pace would be now. The part you will use before the reset is hatched, and the status says when it runs out."
        short="Each window fills in its provider's colour; the part you'll use before the reset is hatched."
      >
        <div className={s.quotas}>
          {groups(quotas).map((g) => (
            <QuotaGroup key={g.provider} g={g} settings={DEFAULT_SETTINGS} now={now} />
          ))}
        </div>
      </Section>

      <Section
        flip
        title="One tap, back in the session"
        text="The agent asks and keeps working. Your answer reaches its session as the next prompt."
      >
        <div className={s.crop}>
          <Phone
            name="android-question"
            alt="A question in Android's sheet, with its two options"
          />
        </div>
      </Section>

      <Section
        title="Runs that need you at the machine"
        text="When an agent starts something that takes over your screen or keyboard, it says why, and the run's progress stays on your lock screen until it passes or fails."
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
        <h2 className="t-title">Install on each machine</h2>
        <p className={`t-prose ${s.dim} ${s.wideOnly}`}>
          The CLI sets up the agent service and the Claude Code plugin.
        </p>
        <Install />
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
          <a href="#features">Quota windows</a>
          <a href="#features">Questions</a>
          <a href="#features">Permission prompts</a>
          <a href="#features">Runs</a>
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

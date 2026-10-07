"use client";

import { track } from "@/lib/analytics";
import { HOSTED } from "@/lib/installCommands";
import { AGENTS_GUIDE, REPO, SELF_HOST } from "@/lib/links";
import { usePageOrigin } from "@/lib/pageOrigin";
import { useGitHubSignIn } from "@/lib/signInMethods";
import { Analytics } from "./Analytics";
import { InstallBox } from "./InstallBox";
import { Icon, Mark } from "./icons";
import s from "./Landing.module.css";
import ui from "./ui.module.css";

// Product shots in public/landing, at 1.5x for the web inbox and 2x for the phones:
//   web-inbox-*      the app at /sample-hero (development only), 1440 by 900, after a click
//                    on the question with images
//   android-inbox-*, android-question-*  Roborazzi shots of the app: `inbox-landing`, `sheet-pick`
//   android-lock-*   the design v2 mockups' lock screen, which Roborazzi cannot render
// All show the Play Store screenshots' neutral data (#448): lib/sample.ts, and Showcase.kt for
// Android; the lock screen carries the same machines, projects and question.
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

// On since Google's review of the closed test passed; README.md's Google Play line carries the
// same two links (#576).
const PLAY_TEST_OPEN = true;

const OBTAINIUM = `https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/${REPO}`;

const FEATURES = [
  ["Questions", "Decide from anywhere. Your tap becomes the agent's next prompt."],
  ["Runs", "Builds, releases and heavy jobs stay on your lock screen until they end."],
  [
    "Quotas",
    "What's left on each AI plan, from CodexBar, with an optional alert before a window runs out.",
  ],
  ["Permission prompts", "Allow or deny a command away from the keyboard. Off by default."],
] as const;

/** Docs opened from the landing page; the docs pages count their own views. */
const openDocs = (page: string) => () => track("open-docs", { page });

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
  // A server without GitHub signs in with its owner token instead.
  const github = useGitHubSignIn();
  // A self-hosted page names its own server where starbridge.run's names itself (#772).
  const origin = usePageOrigin();
  const hosted = origin === HOSTED;
  const pageHost = new URL(origin).host;
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
          <a href="/docs" onClick={openDocs("/docs")}>
            Docs
          </a>
          <a href={REPO}>GitHub</a>
        </nav>
        {github ? (
          <a
            href="/v1/auth/github"
            className={`t-label ${ui.btn} ${ui.fill} ${s.signIn}`}
            onClick={() => track("sign-in", { via: "header" })}
          >
            Sign in
          </a>
        ) : (
          <button
            type="button"
            className={`t-label ${ui.btn} ${ui.fill} ${s.signIn}`}
            onClick={onOwnerToken}
          >
            Sign in
          </button>
        )}
      </header>

      <section className={s.hero}>
        <h1 className={`t-hero ${s.headline}`}>Know the moment your agent is stuck</h1>
        <p className={`t-lead ${s.dim} ${s.lead}`}>
          When a coding agent stops for a question, your phone tells you. Answer with one tap and it
          gets back to work. Your phone also shows permission prompts and what's left on each AI
          plan.
        </p>
        <div className={s.actions}>
          {github ? (
            <a
              href="/v1/auth/github"
              className={`t-action ${ui.btn} ${ui.lg} ${ui.fill}`}
              onClick={() => track("sign-in", { via: "hero" })}
            >
              <Icon name="github" size={18} />
              Sign in with GitHub
            </a>
          ) : (
            <button
              type="button"
              className={`t-action ${ui.btn} ${ui.lg} ${ui.fill}`}
              onClick={onOwnerToken}
            >
              Sign in
            </button>
          )}
          <a href="#install" className={`t-action ${ui.btn} ${ui.lg}`}>
            Install the CLI
          </a>
          <a href="#get-the-app" className={`t-action ${ui.btn} ${ui.lg}`}>
            <Icon name="phone" size={18} />
            Get the app
          </a>
        </div>
        <p className={`t-meta ${s.faint} ${s.wideOnly}`}>
          Open source, MIT · end-to-end encrypted ·{" "}
          {hosted ? "self-host or use starbridge.run" : "self-hosted"}
        </p>
      </section>

      <div className={s.showcase}>
        <div className={s.glow} aria-hidden="true" />
        <div className={s.browser}>
          <div className={s.chrome} aria-hidden="true">
            <i />
            <i />
            <i />
            <span className="t-caption">{pageHost}</span>
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
        <p className={`t-small ${s.dim} ${s.wideOnly}`}>
          After Homebrew or npm, run <code className={s.inlineCode}>starbridge setup</code> to pair
          the machine and install Starbridge in your agents. The scripts run it for you.
        </p>
        <InstallBox counted />
        <p className={`t-meta ${s.faint}`}>
          Works best with Claude Code. Codex, Pi and opencode are supported.
        </p>
      </section>

      <section id="get-the-app" className={s.installSection}>
        <h2 className="t-title">Get the app</h2>
        <div className={s.apps}>
          <div className={s.app}>
            <h3 className="t-prose">Android</h3>
            <p className={`t-reading ${s.dim}`}>
              The signed APK, for Android 12 and later. Add it to Obtainium to get updates.
            </p>
            <div className={s.appLinks}>
              <a href={`${REPO}/releases`} onClick={() => track("get-app", { via: "releases" })}>
                GitHub Releases
              </a>
              <a href={OBTAINIUM} onClick={() => track("get-app", { via: "obtainium" })}>
                Obtainium
              </a>
            </div>
          </div>
          {PLAY_TEST_OPEN && (
            <div className={s.app}>
              <h3 className="t-prose">Google Play</h3>
              <p className={`t-reading ${s.dim}`}>
                In closed testing, and looking for testers. Join the group, then opt in.
              </p>
              <div className={s.appLinks}>
                <a
                  href="https://groups.google.com/g/starbridge-testers"
                  onClick={() => track("get-app", { via: "play-group" })}
                >
                  Testers group
                </a>
                <a
                  href="https://play.google.com/apps/testing/dev.starbridge.app"
                  onClick={() => track("get-app", { via: "play-opt-in" })}
                >
                  Opt in
                </a>
              </div>
            </div>
          )}
          <div className={s.app}>
            <h3 className="t-prose">iOS</h3>
            <p className={`t-reading ${s.dim}`}>
              Add {pageHost} to the Home Screen from Safari to get notifications, on iOS 16.4 and
              later. A native app is planned.
            </p>
          </div>
        </div>
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
          <a href={SELF_HOST} onClick={openDocs(SELF_HOST)}>
            Self-host
          </a>
          <button type="button" className={s.textButton} onClick={onOwnerToken}>
            Use your own server
          </button>
          <a href={AGENTS_GUIDE} onClick={openDocs(AGENTS_GUIDE)}>
            Agent instructions
          </a>
          <a href={`${REPO}/releases`}>Changelog</a>
        </div>
        <div className={s.footCol}>
          <span>Legal</span>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </div>
        <nav className={s.footInline} aria-label="Links">
          <a href={REPO}>GitHub</a>
          <a href={SELF_HOST} onClick={openDocs(SELF_HOST)}>
            Self-host
          </a>
          <a href={AGENTS_GUIDE} onClick={openDocs(AGENTS_GUIDE)}>
            Agent instructions
          </a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}

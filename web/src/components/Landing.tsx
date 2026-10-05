import { track } from "@/lib/analytics";
import { Analytics } from "./Analytics";
import { Mark } from "./icons";
import s from "./Landing.module.css";
import ui from "./ui.module.css";

const REPO = "https://github.com/T0mSIlver/starbridge";

// Roborazzi screenshots from android/app/screenshots, cropped below a whole card (quotas
// at 1899 px, decision 1454, inbox-prompts 2104)
// with 60 px of the screen's background added, so no frame cuts a line:
//   ffmpeg -i quotas-dark.png -vf "crop=1233:1899:0:0,pad=1233:1959:0:0:0x0c0c0c,scale=616:-1" -quality 82 quotas-dark.webp
// Light pads with 0xf4f4f4. `height` is the webp's height at 616 px wide.
const FEATURES = [
  {
    shot: "quotas",
    height: 979,
    title: "Quota windows",
    text: "Every AI plan's limits on one screen, read from CodexBar: whether you will run out before the reset, and headroom about to go unused.",
    alt: "Quota cards: one window will run out, two have headroom unused",
  },
  {
    shot: "decision",
    height: 756,
    title: "Decisions",
    text: "An agent asks a question with options and keeps working. Your tap goes back into its session as a prompt.",
    alt: "A decision with two options, the recommended one in amber",
  },
  {
    shot: "inbox-prompts",
    height: 1081,
    title: "Permission prompts",
    text: "Claude Code's permission prompts from every session and machine in one list: allow once, for the session, always, or deny.",
    alt: "A Bash permission prompt with allow and deny buttons",
  },
];

const INSTALL = [
  { label: "Script", cmd: "curl -fsSL https://starbridge.run/install.sh | sh" },
  { label: "Homebrew", cmd: "brew install T0mSIlver/starbridge/starbridge" },
  { label: "npm", cmd: "npm i -g starbridge" },
];

function Shot({ name, alt, height }: { name: string; alt: string; height: number }) {
  // Dark is the default where the browser reports no preference (DESIGN.md, "Rules").
  return (
    <picture>
      <source media="(prefers-color-scheme: light)" srcSet={`/landing/${name}-light.webp`} />
      <img
        className={s.shot}
        src={`/landing/${name}-dark.webp`}
        alt={alt}
        width={616}
        height={height}
        loading="lazy"
      />
    </picture>
  );
}

/** What a visitor without a device on this browser sees at `/`. */
export function Landing({ onOwnerToken }: { onOwnerToken: () => void }) {
  return (
    <main className={s.page}>
      <Analytics />
      <header className={s.top}>
        <span className={s.brand}>
          <Mark />
          <span className="t-heading">Starbridge</span>
        </span>
        <a className={`t-label ${s.link}`} href={REPO}>
          GitHub
        </a>
      </header>

      <section className={s.hero}>
        <h1 className="t-display">Supervise your coding agents from your phone.</h1>
        <p className={`t-body ${s.lede}`}>
          Quota windows, decisions and permission prompts, answered with one tap and pushed back
          into the session.
        </p>
        <div className={s.actions}>
          <a href="/v1/auth/github" className={`${ui.button} ${ui.primary}`}>
            Sign in with GitHub
          </a>
          <a href="#install" className={ui.button}>
            Install
          </a>
        </div>
      </section>

      <div className={s.features}>
        {FEATURES.map((f) => (
          <section key={f.shot} className={s.feature}>
            <h2 className="t-heading">{f.title}</h2>
            <p className={s.lede}>{f.text}</p>
            <Shot name={f.shot} alt={f.alt} height={f.height} />
          </section>
        ))}
      </div>

      <section className={s.block}>
        <h2 className="t-heading">End-to-end encrypted</h2>
        <p className={s.lede}>
          Your phone, your browsers and your machines hold the keys. The server only holds
          ciphertext.
        </p>
      </section>

      <section id="install" className={s.block}>
        <h2 className="t-heading">Install</h2>
        <p className={s.lede}>
          On each machine that runs agents, install the CLI. It then sets up the agent service and
          the Claude Code plugin.
        </p>
        <dl className={s.install}>
          {INSTALL.map((i) => (
            <div key={i.label}>
              <dt className="t-label">{i.label}</dt>
              <dd onCopy={() => track("copy-install", { method: i.label })}>
                <code className={`t-code ${s.cmd}`}>{i.cmd}</code>
              </dd>
            </div>
          ))}
        </dl>
        <p className={s.lede}>
          On Android, install the APK from{" "}
          <a className={s.link} href={`${REPO}/releases/latest`}>
            GitHub Releases
          </a>
          . On iPhone and desktop, install this page as an app, with notifications.
        </p>
      </section>

      <footer className={s.foot}>
        <a className={s.link} href={REPO}>
          Source on GitHub, MIT licence
        </a>
        <a className={s.link} href="/privacy">
          Privacy
        </a>
        <a className={s.link} href="/terms">
          Terms
        </a>
        <button type="button" className={s.textButton} onClick={onOwnerToken}>
          Self-hosted: sign in with the owner token
        </button>
      </footer>
    </main>
  );
}

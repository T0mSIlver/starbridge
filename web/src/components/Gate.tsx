"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "./AppProvider";
import { StarIcon } from "./icons";
import { Setup } from "./Setup";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className={s.page}>
      <div className={s.brand}>
        <span className={s.mark}>
          <StarIcon size={18} />
        </span>
        <span className="t-heading">Starbridge</span>
      </div>
      {children}
    </main>
  );
}

/** Runs `fn`, showing its error; `busy` disables the buttons meanwhile. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className={ui.field}>
      <label className="t-label" htmlFor="device-name">
        Name this browser
      </label>
      <input
        id="device-name"
        className={ui.input}
        value={value}
        maxLength={100}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function useDefaultName(): [string, (v: string) => void] {
  const [name, setName] = useState("");
  useEffect(() => {
    load().then((d) => setName((n) => n || d.defaultName()));
  }, []);
  return [name, setName];
}

function SignIn() {
  const { reload } = useApp();
  const [token, setToken] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Page>
      <h1 className="t-title">Sign in</h1>
      <p className={s.lede}>Your AI quota windows and the decisions your agents need from you.</p>
      <a href="/v1/auth/github" className={`${ui.button} ${ui.primary} ${s.go}`}>
        Sign in with GitHub
      </a>
      <details>
        <summary className="t-small">Self-hosted: sign in with the owner token</summary>
        <form
          className={ui.field}
          style={{ marginTop: "var(--s3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const { api } = await import("@/lib/api");
              await api.ownerSignIn(token);
              await reload();
            });
          }}
        >
          <label className="t-label" htmlFor="owner-token">
            Owner token
          </label>
          <input
            id="owner-token"
            type="password"
            className={ui.input}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" className={ui.button} disabled={busy || !token}>
            Sign in
          </button>
        </form>
      </details>
      {error && <p className={ui.error}>{error}</p>}
    </Page>
  );
}

function FirstDevice({ account }: { account: string }) {
  const { reload } = useApp();
  const [name, setName] = useDefaultName();
  const [words, setWords] = useState<string[]>();
  const { busy, error, run } = useAction();
  if (words) return <Setup device={name} words={words} onContinue={reload} />;
  return (
    <Page>
      <h1 className="t-title">Set up this browser</h1>
      <p className={s.lede}>
        This browser becomes your account&apos;s first device. It makes its own keys; the server
        only ever sees public keys and ciphertext. Next you get a recovery key, shown once.
      </p>
      <NameField value={name} onChange={setName} />
      <button
        type="button"
        className={`${ui.button} ${ui.primary} ${s.go}`}
        disabled={busy || !name.trim()}
        onClick={() =>
          run(async () => setWords(await (await load()).setUpFirstDevice(account, name.trim())))
        }
      >
        {busy ? "Making keys…" : "Make keys"}
      </button>
      {error && <p className={ui.error}>{error}</p>}
    </Page>
  );
}

function Join({ account, stale }: { account: string; stale: boolean }) {
  const { reload } = useApp();
  const [name, setName] = useDefaultName();
  const [mode, setMode] = useState<"choose" | "code" | "words">("choose");
  const [code, setCode] = useState<string>();
  const [words, setWords] = useState("");
  const cancel = useRef<() => void>(undefined);
  const { busy, error, run } = useAction();
  useEffect(() => () => cancel.current?.(), []);

  const pair = () =>
    run(async () => {
      setMode("code");
      const join = await (await load()).startJoin(account, name.trim());
      cancel.current = join.cancel;
      setCode(join.code);
      await join.done;
      await reload();
    });

  return (
    <Page>
      <h1 className="t-title">Add this browser</h1>
      <p className={s.lede}>
        Your account already has a device. Approve this browser from it, or use your recovery key if
        you lost every device.
      </p>
      {stale && (
        <p className={ui.notice}>
          This browser was a device of this account, but this sign-in is not bound to it. Add it
          again, then revoke the old entry under Devices.
        </p>
      )}
      {mode === "choose" && (
        <>
          <NameField value={name} onChange={setName} />
          <button
            type="button"
            className={`${ui.button} ${ui.primary} ${s.go}`}
            disabled={!name.trim()}
            onClick={pair}
          >
            Get a pairing code
          </button>
          <button type="button" className={`${ui.button} ${s.go}`} onClick={() => setMode("words")}>
            Use the recovery key
          </button>
        </>
      )}
      {mode === "code" && (
        <>
          <p className={s.step}>
            On your phone or another signed-in browser, open Devices and enter this code. It expires
            in 10 minutes.
          </p>
          <p className="t-figure" data-testid="pairing-code">
            {code ?? "…"}
          </p>
          {busy && <p className="t-small">Waiting for approval…</p>}
        </>
      )}
      {mode === "words" && (
        <form
          className={ui.field}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await (await load()).recover(account, name.trim(), words);
              await reload();
            });
          }}
        >
          <NameField value={name} onChange={setName} />
          <label className="t-label" htmlFor="recovery-words">
            Your 24 recovery words
          </label>
          <textarea
            id="recovery-words"
            className={ui.input}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <button
            type="submit"
            className={`${ui.button} ${ui.primary}`}
            disabled={busy || !name.trim() || words.trim().split(/\s+/).length !== 24}
          >
            Recover
          </button>
          <p className="t-small">Afterwards, revoke the devices you lost under Devices.</p>
        </form>
      )}
      {error && <p className={ui.error}>{error}</p>}
    </Page>
  );
}

function Revoked({ account, name }: { account: string; name: string }) {
  const { reload } = useApp();
  const { busy, error, run } = useAction();
  return (
    <Page>
      <h1 className="t-title">{name} was revoked</h1>
      <p className={s.lede}>
        Another device removed this browser from the account. It can no longer read or answer
        anything. To use it again, add it as a new device.
      </p>
      <button
        type="button"
        className={`${ui.button} ${ui.primary} ${s.go}`}
        disabled={busy}
        onClick={() =>
          run(async () => {
            const store = await import("@/lib/store");
            await store.del("device", account);
            await reload();
          })
        }
      >
        Forget its keys and add it again
      </button>
      {error && <p className={ui.error}>{error}</p>}
    </Page>
  );
}

function Problem({ title, text, error }: { title: string; text: string; error: string }) {
  const { reload } = useApp();
  return (
    <Page>
      <h1 className="t-title">{title}</h1>
      <p className={s.lede}>{text}</p>
      <p className={ui.error}>{error}</p>
      <button type="button" className={`${ui.button} ${s.go}`} onClick={reload}>
        Try again
      </button>
    </Page>
  );
}

/** Shows the screen for where this browser stands, and the app once it is a ready device. */
export function Gate({ children }: { children: React.ReactNode }) {
  const { boot } = useApp();
  switch (boot.state) {
    case "loading":
      return (
        <Page>
          <p className="t-small">Checking your devices…</p>
        </Page>
      );
    case "error":
      return (
        <Problem
          title="Cannot load your account"
          text="The server did not answer as expected."
          error={boot.error}
        />
      );
    case "signed-out":
      return <SignIn />;
    case "first-device":
      return <FirstDevice account={boot.account} />;
    case "join":
      return <Join account={boot.account} stale={boot.stale} />;
    case "revoked":
      return <Revoked account={boot.account} name={boot.name} />;
    case "broken":
      return (
        <Problem
          title="The device list did not verify"
          text="The server sent a device list that does not extend the one this browser trusts, so nothing was decrypted. The server, or someone with access to it, changed the list."
          error={boot.error}
        />
      );
    case "ready":
      return children;
  }
}

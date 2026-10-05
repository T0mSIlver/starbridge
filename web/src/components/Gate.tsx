"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FirstDevice as PreparedDevice, RecoveryEntry } from "@/lib/device";
import { hasPairCode, holdPairCode } from "@/lib/pairLink";
import { useApp } from "./AppProvider";
import { Icon } from "./icons";
import { Landing } from "./Landing";
import { QrCode } from "./QrCode";
import { FirstRunPage, Setup } from "./Setup";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A wait this page cancelled itself, such as the QR code's when switching to digits. */
const cancelled = (e: unknown) =>
  (e instanceof DOMException && e.name === "AbortError") || message(e) === "cancelled";

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
      if (!cancelled(e)) setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Error_({ error }: { error?: string }) {
  return error ? (
    <p className={`t-small ${s.error}`} role="alert">
      {error}
    </p>
  ) : null;
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className={s.field}>
      <label className={`t-meta ${s.dim}`} htmlFor="device-name">
        Name this browser
      </label>
      <input
        id="device-name"
        className={`t-body ${s.input}`}
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

/** GitHub sign-in; self-hosting sits behind "Use your own server" (SPEC.md, design v2). */
export function SignIn({ ownServer = false }: { ownServer?: boolean }) {
  const { reload } = useApp();
  const [own, setOwn] = useState(ownServer);
  const [token, setToken] = useState("");
  const { busy, error, run } = useAction();
  return (
    <FirstRunPage centered>
      <h1 className="t-heading">Sign in to Starbridge</h1>
      <a href="/v1/auth/github" className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${s.go}`}>
        <Icon name="github" size={18} />
        Continue with GitHub
      </a>
      {own ? (
        <form
          className={s.field}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const { api } = await import("@/lib/api");
              await api.ownerSignIn(token);
              await reload();
            });
          }}
        >
          <label className={`t-meta ${s.dim}`} htmlFor="owner-token">
            Owner token
          </label>
          <input
            id="owner-token"
            type="password"
            className={`t-body ${s.input}`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" className={`t-label ${ui.btn}`} disabled={busy || !token}>
            Sign in
          </button>
        </form>
      ) : (
        <button type="button" className={`t-meta ${s.link}`} onClick={() => setOwn(true)}>
          Use your own server
        </button>
      )}
      <Error_ error={error} />
    </FirstRunPage>
  );
}

/** Shown only when the account has no device yet: this browser makes its keys. */
function FirstDevice({ account }: { account: string }) {
  const { reload } = useApp();
  const [name, setName] = useDefaultName();
  const [recoveryKey, setRecoveryKey] = useState<string>();
  // Kept across a failed attempt, so a retry posts the same keys and entry.
  const pending = useRef<PreparedDevice>(undefined);
  const { busy, error, run } = useAction();
  if (recoveryKey) return <Setup device={name} recoveryKey={recoveryKey} onContinue={reload} />;
  return (
    <FirstRunPage>
      <h1 className="t-heading">Set up your account</h1>
      <p className={`t-small ${s.lede}`}>This browser creates your account&apos;s keys.</p>
      <NameField value={name} onChange={setName} />
      <button
        type="button"
        className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${s.go}`}
        disabled={busy || !name.trim()}
        onClick={() =>
          run(async () => {
            pending.current ??= await (await load()).prepareFirstDevice(account, name.trim());
            await pending.current.commit();
            setRecoveryKey(pending.current.recoveryKey);
          })
        }
      >
        {busy ? "Creating the keys…" : error ? "Try again" : "Create the keys"}
      </button>
      <Error_ error={error} />
    </FirstRunPage>
  );
}

/**
 * The account has devices: one of them scans this browser's QR code (or types its code), which
 * compares nothing; comparing digits is the fallback, and the recovery key the last resort.
 */
function Join({ account, stale }: { account: string; stale: boolean }) {
  const { reload } = useApp();
  const [name, setName] = useDefaultName();
  const [mode, setMode] = useState<"code" | "digits" | "key">("code");
  const [code, setCode] = useState<string>();
  const [digits, setDigits] = useState<string>();
  const [typedKey, setTypedKey] = useState("");
  const [typed, setTyped] = useState<RecoveryEntry>({ complete: false, status: "" });
  const cancel = useRef<() => void>(undefined);
  // Each join started counts up; one that resolves after the owner moved on cancels itself.
  const started = useRef(0);
  const { busy, error, run } = useAction();
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => {
    let live = true;
    load().then((d) => live && setTyped(d.readRecoveryEntry(typedKey)));
    return () => {
      live = false;
    };
  }, [typedKey]);

  /** Starts a join unless the owner moved on meanwhile; undefined when stale. */
  const begin = async <J extends { cancel: () => void; done: Promise<void> }>(
    start: () => Promise<J>,
  ) => {
    const mine = ++started.current;
    const join = await start();
    if (mine !== started.current) {
      join.done.catch(() => {});
      join.cancel();
      return undefined;
    }
    cancel.current = join.cancel;
    return join;
  };

  // The code carries the name it asks under, so it waits for the default name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once the name is known
  useEffect(() => {
    if (mode !== "code" || !name || code) return;
    run(async () => {
      const join = await begin(async () => (await load()).startJoin(account, name.trim()));
      if (!join) return;
      setCode(join.code);
      await join.done;
      await reload();
    });
  }, [mode, name === ""]);

  const switchTo = (next: "digits" | "key") => {
    started.current++;
    cancel.current?.();
    setCode(undefined);
    setDigits(undefined);
    setMode(next);
    if (next === "digits")
      run(async () => {
        const join = await begin(async () => (await load()).startDigitJoin(account, name.trim()));
        if (!join) return;
        join.digits.then(setDigits, () => {});
        await join.done;
        await reload();
      });
  };

  return (
    <FirstRunPage centered>
      <h1 className="t-heading">Add this browser</h1>
      {stale && (
        <p className={`t-small ${s.lede}`}>
          This browser was a device of this account, but this sign-in is not bound to it. Add it
          again, then revoke the old one in Settings.
        </p>
      )}
      {mode === "code" && (
        <>
          <p className={`t-small ${s.lede}`}>
            Scan with a phone or browser signed in to Starbridge.
          </p>
          {!code && !error && <span className={`skeleton ${s.qrBone}`} aria-hidden />}
          {code && (
            <>
              <div className={s.qr}>
                <QrCode
                  className={s.qrSvg}
                  text={`${location.origin}/pair#${code}`}
                  label={`QR code for pairing code ${code}`}
                />
              </div>
              <p className={`t-snippet ${s.dim}`} data-testid="pairing-code">
                {code}
              </p>
            </>
          )}
          <button
            type="button"
            className={`t-meta ${s.link}`}
            disabled={!name.trim()}
            onClick={() => switchTo("digits")}
          >
            Can&apos;t scan? Compare digits
          </button>
        </>
      )}
      {mode === "digits" && (
        <>
          <p className={`t-small ${s.lede}`}>
            {digits
              ? `Approve ${name.trim()} on your other device if the digits match.`
              : `Open Starbridge on a signed-in device: it asks whether to let ${name.trim()} join.`}
          </p>
          {digits && (
            <div className={`t-heading ${s.digits}`} data-testid="join-digits">
              {[...digits].map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a digit's place is its identity
                <span key={i} className={s.digit}>
                  {d}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            className={`t-label ${ui.btn}`}
            onClick={() => {
              started.current++;
              cancel.current?.();
              setMode("code");
            }}
          >
            Cancel
          </button>
        </>
      )}
      {mode === "key" ? (
        <form
          className={s.field}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await (await load()).recover(account, name.trim(), typedKey);
              await reload();
            });
          }}
        >
          <NameField value={name} onChange={setName} />
          <label className={`t-meta ${s.dim}`} htmlFor="recovery-key">
            Your recovery key
          </label>
          <textarea
            id="recovery-key"
            className={`t-snippet ${s.input}`}
            rows={2}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="recovery-key-check"
            value={typedKey}
            onChange={(e) => setTypedKey(e.target.value)}
          />
          <p
            id="recovery-key-check"
            className={`t-meta ${typed.problem ? s.error : s.dim}`}
            aria-live="polite"
          >
            {typed.problem ?? typed.status}
          </p>
          <button
            type="submit"
            className={`t-label ${ui.btn} ${ui.fill}`}
            disabled={busy || !name.trim() || !typed.complete}
          >
            Recover
          </button>
        </form>
      ) : (
        <button type="button" className={`t-meta ${s.link}`} onClick={() => switchTo("key")}>
          Use the recovery key
        </button>
      )}
      <Error_ error={error} />
    </FirstRunPage>
  );
}

function Revoked({ account, name }: { account: string; name: string }) {
  const { reload } = useApp();
  const { busy, error, run } = useAction();
  return (
    <FirstRunPage>
      <h1 className="t-heading">{name} was revoked</h1>
      <p className={`t-small ${s.lede}`}>It can no longer read or answer anything.</p>
      <button
        type="button"
        className={`t-label ${ui.btn} ${ui.lg} ${ui.fill} ${s.go}`}
        disabled={busy}
        onClick={() =>
          run(async () => {
            const store = await import("@/lib/store");
            await store.del("device", account);
            await reload();
          })
        }
      >
        Add it again
      </button>
      <Error_ error={error} />
    </FirstRunPage>
  );
}

function Problem({ title, text, error }: { title: string; text: string; error: string }) {
  const { reload } = useApp();
  return (
    <FirstRunPage>
      <h1 className="t-heading">{title}</h1>
      <p className={`t-small ${s.lede}`}>{text}</p>
      <Error_ error={error} />
      <button type="button" className={`t-label ${ui.btn}`} onClick={reload}>
        Try again
      </button>
    </FirstRunPage>
  );
}

/** Shows the screen for where this browser stands, and the app once it is a ready device. */
export function Gate({ children }: { children: React.ReactNode }) {
  const { boot } = useApp();
  const [ownServer, setOwnServer] = useState(false);
  const router = useRouter();
  const path = usePathname();
  // A pairing link opened before sign-in or setup: keep its code, and go back to it after.
  useEffect(() => holdPairCode(), []);
  useEffect(() => {
    if (boot.state === "ready" && path !== "/pair" && hasPairCode()) router.replace("/pair");
  }, [boot.state, path, router]);
  switch (boot.state) {
    case "loading":
      // Plain ground until boot knows the screen: the landing page, sign-in or the app.
      return null;
    case "error":
      return (
        <Problem
          title="Cannot load your account"
          text="The server did not answer as expected."
          error={boot.error}
        />
      );
    case "signed-out":
      // Visitors land on the landing page; a browser with a device signs in to its Inbox.
      if (path === "/" && !boot.known && !ownServer)
        return <Landing onOwnerToken={() => setOwnServer(true)} />;
      return <SignIn ownServer={ownServer} />;
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
          text="The server sent a device list that does not extend the one this browser trusts, so nothing was decrypted."
          error={boot.error}
        />
      );
    case "ready":
      return children;
  }
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ShownCode } from "@/lib/device";
import { timer } from "@/lib/feed";
import { holdPairCode, takePairCode } from "@/lib/pairLink";
import type { PairingRequest } from "@/lib/types";
import { useApp, useDevice } from "./AppProvider";
import { useNow } from "./Feed";
import { Icon } from "./icons";
import p from "./Pairing.module.css";
import { type PairOutcome, PairResult } from "./PairResult";
import { PhoneBar } from "./PhoneBar";
import { QrCode } from "./QrCode";
import s from "./Settings.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A pairing code lasts 10 minutes (lib/device.ts). */
const CODE_MS = 10 * 60_000;

/**
 * Adding a device is scan-first: this page shows a QR code for the new phone to scan, which
 * compares nothing because the code travels through the camera. A machine's `starbridge pair`
 * code, or a pairing link, still works below it.
 */
export function AddDevice() {
  const ctx = useDevice();
  const { update } = useApp();
  const [code, setCode] = useState("");
  const [req, setReq] = useState<PairingRequest>();
  const [shown, setShown] = useState<ShownCode & { until: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<PairOutcome>();
  const cancelShown = useRef<() => void>(undefined);
  /** The code of the last pairing link this tab opened. */
  const latest = useRef<string>(undefined);
  const now = useNow(!!shown);
  useEffect(() => () => cancelShown.current?.(), []);

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

  const showQr = () =>
    run(async () => {
      const next = await (await load()).showPairingCode();
      cancelShown.current = next.cancel;
      setShown({ ...next, until: Date.now() + CODE_MS });
      next.request.then(
        (r) => {
          setShown(undefined);
          // A request from the QR code replaces the result of a typed code approved meanwhile.
          setDone(undefined);
          setReq(r);
        },
        (e) => {
          setShown(undefined);
          if (message(e) !== "cancelled") setError(message(e));
        },
      );
    });

  // A `starbridge pair` link, /pair#<code>, possibly held through sign-in; else the QR code.
  // Another link opened in this tab changes only the hash: it replaces what the page shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    const arrive = () => {
      holdPairCode();
      const fromLink = takePairCode();
      if (!fromLink) return false;
      // The QR code and whatever the page showed belong to the request before this one.
      cancelShown.current?.();
      setShown(undefined);
      setDone(undefined);
      setReq(undefined);
      setCode(fromLink);
      latest.current = fromLink;
      run(async () => {
        const r = await (await load()).readPairing(fromLink);
        // A link opened since then has the page now.
        if (latest.current === fromLink) setReq(r);
      });
      return true;
    };
    if (!arrive()) showQr();
    window.addEventListener("hashchange", arrive);
    return () => window.removeEventListener("hashchange", arrive);
  }, []);

  const reset = (outcome: PairOutcome) => {
    setDone(outcome);
    setReq(undefined);
    setCode("");
  };

  return (
    <>
      <PhoneBar title="Add a device" find={false} />
      <div className={s.page}>
        <div>
          <nav className={`t-small ${p.crumbs}`} aria-label="Breadcrumb">
            <Link href="/settings">Settings</Link> / Devices
          </nav>
          <h1 className={`t-heading ${s.title}`}>Add a device</h1>
        </div>
        {done ? (
          <PairResult outcome={done}>
            <Link href="/settings" className={`t-label ${ui.btn} ${ui.rec}`}>
              Back to Devices
            </Link>
          </PairResult>
        ) : req ? (
          <article className={`m-appear ${p.panel}`} aria-label="Pairing request">
            <div className={`t-meta ${p.meta}`}>
              <Icon name={req.role === "machine" ? "desktop" : "phone"} size={16} />
              <span>{req.name}</span>
              <span className={p.right}>just now</span>
            </div>
            <div>
              <h2 className="t-action">
                {req.role === "machine"
                  ? `Let ${req.name} post decisions and quotas?`
                  : `Let ${req.name} read and answer as a device?`}
              </h2>
              <p className={`t-small ${p.dim}`}>
                {req.role === "machine"
                  ? `Approve only if you just ran starbridge setup or pair on ${req.name}.`
                  : `Approve only if ${req.name} scanned or showed this code.`}
              </p>
            </div>
            <div className={p.actions}>
              <button
                type="button"
                className={`t-label ${ui.btn} ${ui.rec}`}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    update(await (await load()).approvePairing(ctx, req));
                    reset({
                      name: req.name,
                      icon: req.role === "machine" ? "desktop" : "phone",
                      title: `${req.name} joined`,
                      sub:
                        req.role === "machine"
                          ? "It can now post decisions and quota windows."
                          : "It can now read and answer as a device.",
                    });
                  })
                }
              >
                Approve
              </button>
              <button
                type="button"
                className={`t-label ${ui.btn}`}
                disabled={busy}
                onClick={() =>
                  reset({
                    name: req.name,
                    icon: req.role === "machine" ? "desktop" : "phone",
                    title: `Refused ${req.name}`,
                    sub: "Its code expires within 10 minutes.",
                  })
                }
              >
                Refuse
              </button>
            </div>
          </article>
        ) : shown ? (
          <article className={`${p.panel} ${p.qr}`} aria-label="QR code">
            <div className={p.code}>
              <QrCode
                className={p.qrSvg}
                text={shown.link}
                label={`QR code for pairing code ${shown.code}`}
              />
            </div>
            <div className={p.qrText}>
              <h2 className="t-action">Scan with the new phone</h2>
              <p className={`t-small ${p.dim}`}>
                Expires in {timer(new Date(now).toISOString(), shown.until)}
              </p>
              <p className={`t-snippet ${p.dim}`} data-testid="shown-code">
                {shown.code}
              </p>
              <div className={p.actions}>
                <button
                  type="button"
                  className={`t-meta ${ui.btn} ${ui.sm}`}
                  onClick={() => {
                    shown.cancel();
                    setShown(undefined);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </article>
        ) : busy && !error ? (
          <div className={`${p.panel} ${p.qr}`} aria-hidden>
            <span className={`skeleton ${p.qrBone}`} />
            <div className={p.qrText}>
              <span className={`skeleton ${p.textBone}`} />
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className={`t-label ${ui.btn}`} disabled={busy} onClick={showQr}>
              <Icon name="qr" size={18} /> Show a QR code
            </button>
          </div>
        )}
        {error && (
          <p className={`t-small ${p.error}`} role="alert">
            {error}
          </p>
        )}
        <form
          className={s.section}
          onSubmit={(e) => {
            e.preventDefault();
            setDone(undefined);
            run(async () => setReq(await (await load()).readPairing(code)));
          }}
        >
          <label className="t-action" htmlFor="pairing-code">
            Pair a machine or device
          </label>
          <div className={p.codeRow}>
            <input
              id="pairing-code"
              className={`t-snippet ${p.input}`}
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              type="submit"
              className={`t-label ${ui.btn}`}
              disabled={busy || code.trim().length < 24}
            >
              Check code
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

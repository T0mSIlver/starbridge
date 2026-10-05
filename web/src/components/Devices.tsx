"use client";

import { useEffect, useRef, useState } from "react";
import type { ShownCode } from "@/lib/device";
import { relative } from "@/lib/format";
import { holdPairCode, takePairCode } from "@/lib/pairLink";
import type { Device, PairingRequest } from "@/lib/types";
import { useApp, useDevice } from "./AppProvider";
import s from "./Devices.module.css";
import { QrCode } from "./QrCode";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first 8 characters of the signing key, for comparing devices by eye. */
const fingerprint = (signPk: string) => `${signPk.slice(0, 4)} ${signPk.slice(4, 8)}`;

const ROLE = { device: "Device", machine: "Machine" } as const;

function Row({ d, onRevoke }: { d: Device; onRevoke: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const revoked = d.status === "revoked";
  return (
    <li className={s.row}>
      <div className={s.who}>
        <p className={s.name}>
          {d.name}
          {d.self && <span className={`t-label ${ui.pill} ${ui.info}`}>This device</span>}
          {revoked && <span className={`t-label ${ui.pill} ${ui.muted}`}>Revoked</span>}
        </p>
        <p className={`t-machine ${s.detail}`}>
          {ROLE[d.role]} · key {fingerprint(d.signPk)}
          {d.addedAt ? ` · added ${relative(d.addedAt)}` : ""}
        </p>
        {error && <p className={ui.error}>{error}</p>}
      </div>
      {!revoked && !d.self && (
        <div className={s.actions}>
          {confirming ? (
            <>
              <button type="button" className={ui.button} onClick={() => setConfirming(false)}>
                Keep
              </button>
              <button
                type="button"
                className={`${ui.button} ${ui.danger}`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await onRevoke();
                  } catch (e) {
                    setError(message(e));
                    setBusy(false);
                  }
                }}
              >
                Revoke {d.name}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${ui.button} ${ui.danger}`}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The owner types the code a new member shows, or opens its link, or shows a QR code for a new
 * phone to scan. Either way the request's MAC proves it came from whoever holds the code.
 */
function Pair() {
  const ctx = useDevice();
  const { update } = useApp();
  const [code, setCode] = useState("");
  const [req, setReq] = useState<PairingRequest>();
  const [shown, setShown] = useState<ShownCode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const cancelShown = useRef<() => void>(undefined);
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

  // A `starbridge pair` link: /pair#<code>, possibly held through sign-in. The fragment never
  // reached the server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on the link's code
  useEffect(() => {
    holdPairCode();
    const fromLink = takePairCode();
    if (!fromLink) return;
    setCode(fromLink);
    run(async () => setReq(await (await load()).readPairing(fromLink)));
  }, []);

  const showQr = () =>
    run(async () => {
      setDone(undefined);
      const next = await (await load()).showPairingCode();
      cancelShown.current = next.cancel;
      setShown(next);
      next.request.then(
        (r) => {
          setShown(undefined);
          setReq(r);
        },
        (e) => {
          setShown(undefined);
          if (message(e) !== "cancelled") setError(message(e));
        },
      );
    });

  if (shown)
    return (
      <article className={`${ui.card} ${s.pairing}`}>
        <span className={`t-label ${ui.pill} ${ui.beacon}`}>Pairing code</span>
        <h2 className="t-question">Scan this with the Starbridge app on the new phone</h2>
        <p className={s.compare}>
          On the new phone, sign in, then tap Scan a QR code. It expires in 10 minutes.
        </p>
        <QrCode text={shown.link} label={`QR code for pairing code ${shown.code}`} />
        <p className={`t-machine ${s.detail}`} data-testid="shown-code">
          {shown.code}
        </p>
        <p className="t-small">Waiting for the phone…</p>
        <div className={s.pairActions}>
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              shown.cancel();
              setShown(undefined);
            }}
          >
            Cancel
          </button>
        </div>
      </article>
    );

  if (req)
    return (
      <article className={`${ui.card} ${s.pairing}`}>
        <span className={`t-label ${ui.pill} ${ui.beacon}`}>Pairing request</span>
        <h2 className="t-question">
          Let <strong>{req.name}</strong>{" "}
          {req.role === "machine" ? "post decisions and quotas?" : "read and answer as a device?"}
        </h2>
        <p className={s.compare}>
          {req.role === "machine"
            ? `Approve only if you just ran \`starbridge pair\` on ${req.name}.`
            : `Approve only if ${req.name} is the browser or phone that showed or scanned this code.`}
        </p>
        <p className={`t-figure ${s.code}`}>{req.code}</p>
        <p className={`t-machine ${s.detail}`}>
          {ROLE[req.role]} · key {fingerprint(req.signPk)} · asked {relative(req.at)}
        </p>
        {error && <p className={ui.error}>{error}</p>}
        <div className={s.pairActions}>
          <button
            type="button"
            className={`${ui.button} ${ui.beaconFill}`}
            disabled={busy}
            onClick={() =>
              run(async () => {
                update(await (await load()).approvePairing(ctx, req));
                setDone(`${req.name} joined.`);
                setReq(undefined);
                setCode("");
              })
            }
          >
            Approve
          </button>
          <button
            type="button"
            className={ui.button}
            disabled={busy}
            onClick={() => {
              setDone(`Refused ${req.name}. Its code expires within 10 minutes.`);
              setReq(undefined);
              setCode("");
            }}
          >
            Refuse
          </button>
        </div>
      </article>
    );

  return (
    <form
      className={`${ui.card} ${ui.field}`}
      onSubmit={(e) => {
        e.preventDefault();
        setDone(undefined);
        run(async () => setReq(await (await load()).readPairing(code)));
      }}
    >
      <label className="t-label" htmlFor="pairing-code">
        Pair a machine or device
      </label>
      <p className="t-small">
        Type the code that <code className="t-code">starbridge pair</code> printed, or that another
        browser shows.
      </p>
      <input
        id="pairing-code"
        className={ui.input}
        autoComplete="off"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className={s.pairActions}>
        <button type="submit" className={ui.button} disabled={busy || code.trim().length < 24}>
          Check code
        </button>
        <button type="button" className={ui.button} disabled={busy} onClick={showQr}>
          Show a QR code
        </button>
      </div>
      {error && <p className={ui.error}>{error}</p>}
      {done && (
        <p className={ui.notice} role="status">
          {done}
        </p>
      )}
    </form>
  );
}

export function Devices() {
  const ctx = useDevice();
  const { update } = useApp();
  const [all, setAll] = useState<Device[]>([]);
  useEffect(() => {
    load().then((d) => setAll(d.devices(ctx)));
  }, [ctx]);

  const section = (title: string, list: Device[]) => (
    <>
      <h2 className={`t-label ${ui.section}`}>{title}</h2>
      {list.length ? (
        <ul className={`${ui.card} ${s.rows}`}>
          {list.map((d) => (
            <Row
              key={d.id}
              d={d}
              onRevoke={async () => update(await (await load()).revoke(ctx, d.id))}
            />
          ))}
        </ul>
      ) : (
        <p className="t-small">None yet.</p>
      )}
    </>
  );

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Devices</h1>
      </header>
      <Pair />
      {section(
        "Phones and browsers",
        all.filter((d) => d.role === "device"),
      )}
      {section(
        "Machines",
        all.filter((d) => d.role === "machine"),
      )}
      <p className={`t-small ${s.recovery}`}>
        The recovery key was shown once, when this account&apos;s first device was set up. It signs
        a new device if every device is lost; Starbridge cannot show it again.
      </p>
    </>
  );
}

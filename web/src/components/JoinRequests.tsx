"use client";

import { useEffect, useRef, useState } from "react";
import type { Comparison } from "@/lib/device";
import { relative } from "@/lib/format";
import type { JoinAsk } from "@/lib/types";
import { useApp, useDevice } from "./AppProvider";
import s from "./Devices.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const spaced = (digits: string) => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** One join request: compare digits, then approve or refuse. */
function Ask({ ask, onClose }: { ask: JoinAsk; onClose: (done?: string) => void }) {
  const ctx = useDevice();
  const { update } = useApp();
  const [comparison, setComparison] = useState<Comparison>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const elsewhere = ask.approver !== undefined && ask.approver !== ctx.device.id && !comparison;

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

  return (
    <article className={`${ui.card} ${s.pairing}`} data-testid="join-request">
      <span className={`t-label ${ui.pill} ${ui.beacon}`}>Join request</span>
      <h2 className="t-question">
        Let <strong>{ask.name}</strong> read and answer as a device?
      </h2>
      {comparison ? (
        <>
          <p className={s.compare}>Approve only if {ask.name} shows these same digits.</p>
          <p className={`t-figure ${s.code}`} data-testid="join-digits">
            {spaced(comparison.digits)}
          </p>
        </>
      ) : (
        <p className={s.compare}>
          {elsewhere
            ? "Another of your devices is comparing digits for it."
            : `A browser or phone signed in to your account asked to join ${relative(ask.at)}. Compare digits with it before you approve.`}
        </p>
      )}
      {error && <p className={ui.error}>{error}</p>}
      <div className={s.pairActions}>
        {comparison ? (
          <button
            type="button"
            className={`${ui.button} ${ui.beaconFill}`}
            disabled={busy}
            onClick={() =>
              run(async () => {
                update(await comparison.approve(ctx));
                onClose(`${ask.name} joined.`);
              })
            }
          >
            Approve
          </button>
        ) : (
          <button
            type="button"
            className={`${ui.button} ${ui.beaconFill}`}
            disabled={busy || elsewhere}
            onClick={() =>
              run(async () => {
                abort.current = new AbortController();
                setComparison(await (await load()).compareJoin(ctx, ask, abort.current.signal));
              })
            }
          >
            {busy ? "Waiting for it…" : "Compare digits"}
          </button>
        )}
        <button
          type="button"
          className={ui.button}
          disabled={busy && comparison !== undefined}
          onClick={() =>
            run(async () => {
              abort.current?.abort();
              await (await load()).refuseJoin(ask.id);
              onClose(
                comparison
                  ? `Refused ${ask.name}: the digits differed. Ask again from it.`
                  : `Refused ${ask.name}.`,
              );
            })
          }
        >
          {comparison ? "Digits differ" : "Refuse"}
        </button>
      </div>
    </article>
  );
}

/** Join requests from browsers and phones signed in to the account, live while the page is open. */
export function JoinRequests() {
  const [asks, setAsks] = useState<JoinAsk[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [done, setDone] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    load().then((d) => d.watchJoins(abort.signal, setAsks));
    return () => abort.abort();
  }, []);
  const open = asks.filter((a) => !closed.includes(a.id));
  if (!open.length && !done) return null;
  return (
    <section aria-label="Join requests" style={{ marginBottom: "var(--s4)" }}>
      {open.map((a) => (
        <Ask
          key={a.id}
          ask={a}
          onClose={(text) => {
            setClosed((c) => [...c, a.id]);
            setDone(text);
          }}
        />
      ))}
      {done && (
        <p className={ui.notice} role="status">
          {done}
        </p>
      )}
    </section>
  );
}

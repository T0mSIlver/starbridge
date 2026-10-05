"use client";

import { useEffect, useRef, useState } from "react";
import type { Comparison } from "@/lib/device";
import { relative } from "@/lib/format";
import type { JoinAsk } from "@/lib/types";
import { useApp, useDevice } from "./AppProvider";
import { Icon } from "./icons";
import p from "./Pairing.module.css";
import { type PairOutcome, PairResult } from "./PairResult";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");
/** How long a join's result stays before it clears itself. */
const DONE_MS = 8000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One join request: compare digits, then approve or refuse. */
function Ask({ ask, onClose }: { ask: JoinAsk; onClose: (done: PairOutcome) => void }) {
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
    <article className={p.panel} data-testid="join-request" aria-label="Join request">
      <div className={`t-meta ${p.meta}`}>
        <Icon name="devices" size={16} />
        <span>{ask.name}</span>
        <span className={p.right}>{relative(ask.at)}</span>
      </div>
      <div>
        <h2 className="t-action">Approve {ask.name}?</h2>
        <p className={`t-small ${p.dim}`}>
          {comparison
            ? "Approve only if the digits match."
            : elsewhere
              ? "Another of your devices is comparing digits."
              : "Compare digits with it before you approve."}
        </p>
      </div>
      {comparison && (
        <div className={`t-heading ${p.digits}`} data-testid="join-digits">
          {[...comparison.digits].map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a digit's place is its identity
            <span key={i} className={p.digit}>
              {d}
            </span>
          ))}
        </div>
      )}
      {error && <p className={`t-small ${p.error}`}>{error}</p>}
      <div className={p.actions}>
        {comparison ? (
          <button
            type="button"
            className={`t-label ${ui.btn} ${ui.rec}`}
            disabled={busy}
            onClick={() =>
              run(async () => {
                update(await comparison.approve(ctx));
                onClose({
                  name: ask.name,
                  icon: "devices",
                  title: `${ask.name} joined`,
                  sub: "It can now read and answer as a device.",
                });
              })
            }
          >
            Digits match: approve
          </button>
        ) : (
          <button
            type="button"
            className={`t-label ${ui.btn} ${ui.rec}`}
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
          className={`t-label ${ui.btn}`}
          disabled={busy && comparison !== undefined}
          onClick={() =>
            run(async () => {
              abort.current?.abort();
              await (await load()).refuseJoin(ask.id);
              onClose({
                name: ask.name,
                icon: "devices",
                title: `Refused ${ask.name}`,
                sub: comparison ? "The digits differed. Ask again from it." : "It can ask again.",
              });
            })
          }
        >
          {comparison ? "They differ" : "Refuse"}
        </button>
      </div>
    </article>
  );
}

/** Join requests from browsers and phones signed in to the account, live while the page is open. */
export function JoinRequests() {
  const [asks, setAsks] = useState<JoinAsk[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [done, setDone] = useState<PairOutcome>();
  useEffect(() => {
    const abort = new AbortController();
    load().then((d) => d.watchJoins(abort.signal, setAsks));
    return () => abort.abort();
  }, []);
  // The result says what happened, then gets out of the way.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(undefined), DONE_MS);
    return () => clearTimeout(t);
  }, [done]);
  const open = asks.filter((a) => !closed.includes(a.id));
  if (!open.length && !done) return null;
  return (
    <section aria-label="Join requests" className={p.requests}>
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
        <PairResult outcome={done}>
          <button type="button" className={`t-label ${ui.btn}`} onClick={() => setDone(undefined)}>
            OK
          </button>
        </PairResult>
      )}
    </section>
  );
}

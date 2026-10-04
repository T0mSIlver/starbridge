"use client";

import { useState } from "react";
import { relative } from "@/lib/format";
import type { Device } from "@/lib/types";
import s from "./Devices.module.css";
import ui from "./ui.module.css";

const KIND = { phone: "Phone", browser: "Browser", machine: "Machine" } as const;

function Row({ d, onRevoke }: { d: Device; onRevoke: () => void }) {
  const [confirming, setConfirming] = useState(false);
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
          {KIND[d.kind]} · key {d.fingerprint} · seen {relative(d.lastSeen)}
        </p>
      </div>
      {!revoked && !d.self && (
        <div className={s.actions}>
          {confirming ? (
            <>
              <button type="button" className={ui.button} onClick={() => setConfirming(false)}>
                Keep
              </button>
              <button type="button" className={`${ui.button} ${ui.danger}`} onClick={onRevoke}>
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

function Pairing({
  d,
  onApprove,
  onReject,
}: {
  d: Device;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <article className={`${ui.card} ${s.pairing}`}>
      <span className={`t-label ${ui.pill} ${ui.beacon}`}>Pairing request</span>
      <h2 className="t-question">
        Let <strong>{d.name}</strong> post decisions and quotas?
      </h2>
      <p className={s.compare}>
        Approve only if this code matches the one the CLI printed on {d.name}.
      </p>
      <p className={`t-figure ${s.code}`}>{d.pairingCode}</p>
      <p className={`t-machine ${s.detail}`}>
        key {d.fingerprint} · asked {relative(d.addedAt)}
      </p>
      <div className={s.pairActions}>
        <button type="button" className={`${ui.button} ${ui.primary}`} onClick={onApprove}>
          Approve
        </button>
        <button type="button" className={ui.button} onClick={onReject}>
          Reject
        </button>
      </div>
    </article>
  );
}

export function Devices({ devices, machines }: { devices: Device[]; machines: Device[] }) {
  const [all, setAll] = useState([...devices, ...machines]);
  const set = (id: string, status: Device["status"] | null) =>
    setAll((list) =>
      status === null
        ? list.filter((d) => d.id !== id)
        : list.map((d) => (d.id === id ? { ...d, status } : d)),
    );
  const pending = all.filter((d) => d.status === "pending");
  const listed = (kind: (d: Device) => boolean) =>
    all.filter((d) => d.status !== "pending" && kind(d));

  const section = (title: string, list: Device[]) => (
    <>
      <h2 className={`t-label ${ui.section}`}>{title}</h2>
      <ul className={`${ui.card} ${s.rows}`}>
        {list.map((d) => (
          <Row key={d.id} d={d} onRevoke={() => set(d.id, "revoked")} />
        ))}
      </ul>
    </>
  );

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Devices</h1>
      </header>
      {pending.map((d) => (
        <Pairing
          key={d.id}
          d={d}
          onApprove={() => set(d.id, "active")}
          onReject={() => set(d.id, null)}
        />
      ))}
      {section(
        "Phones and browsers",
        listed((d) => d.kind !== "machine"),
      )}
      {section(
        "Machines",
        listed((d) => d.kind === "machine"),
      )}
      <p className={`t-small ${s.recovery}`}>
        The recovery key was shown once, when this account&apos;s first device was set up. It signs
        a new device if every device is lost; Starbridge cannot show it again.
      </p>
    </>
  );
}

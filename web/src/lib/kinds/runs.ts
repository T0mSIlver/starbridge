// Runs: the commands machines report through `starbridge run`, which any device dismisses (#827).
import { ProtocolError } from "@starbridge/protocol";
import { ApiError, api, lastPage } from "../api";
import type { RunItem } from "../types";
import { type Ctx, hold, openMachine } from "./core";

export interface Runs {
  items: RunItem[];
  rejected: { id: string; error: string }[];
}

/** Drops a run from the server, so every device stops showing it (#827). */
export async function dismissRun(ctx: Ctx, id: string): Promise<void> {
  await hold(ctx);
  try {
    await api.deleteItem(id);
  } catch (e) {
    // Already gone: the sweep or another device dropped it.
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
}

/** Every stored run: the server keeps the latest update of each, for a day. */
export async function loadRuns(ctx: Ctx): Promise<Runs> {
  const out: Runs = { items: [], rejected: [] };
  let cursor: string | undefined;
  for (;;) {
    const page = await api.items("run", cursor);
    for (const s of page.items) {
      try {
        const { signer, body } = await openMachine(ctx, s.item, "run");
        out.items.push({ run: body, machine: signer.name });
      } catch (e) {
        if (e instanceof ProtocolError && e.code === "revoked-signer") continue;
        out.rejected.push({ id: s.item.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    cursor = page.cursor;
    if (lastPage(page)) break;
  }
  await hold(ctx);
  return out;
}

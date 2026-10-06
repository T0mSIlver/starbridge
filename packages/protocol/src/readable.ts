import {
  type Kind,
  MachineKind,
  PaceStage,
  QuotaAlert,
  RunProgress,
  Settled,
  Waiting,
} from "./schemas";

const MACHINE_KINDS: readonly string[] = MachineKind.options;
const OUTCOMES: readonly string[] = Settled.shape.outcome.unwrap().options;
const STATES: readonly string[] = Waiting.shape.state.options;
const UNITS: readonly string[] = RunProgress.shape.unit.options;
const STAGES: readonly string[] = PaceStage.options;
const ALERT_KINDS: readonly string[] = QuotaAlert.options.map((o) => o.shape.kind.value);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** A string that is not one of `known`: what a newer sender may send. */
const newer = (v: unknown, known: readonly string[]) => typeof v === "string" && !known.includes(v);

function withSource(body: Obj): Obj {
  const source = body.source;
  if (!isObj(source) || !newer(source.machineKind, MACHINE_KINDS)) return body;
  const { machineKind: _, ...rest } = source;
  return { ...body, source: rest };
}

/**
 * What a reader makes of a body before its schema checks it (PROTOCOL.md, "What a reader
 * keeps"): a string it only displays and does not know reads as the neutral case, and an alert
 * of a kind it does not know is left out. A missing field, or a value of another type, is left
 * for the schema to refuse. Writers check against the schemas alone.
 */
export function readable(kind: Kind, json: unknown): unknown {
  if (!isObj(json)) return json;
  switch (kind) {
    case "decision":
    case "permission":
      return withSource(json);
    case "settled": {
      if (!newer(json.outcome, OUTCOMES)) return json;
      const { outcome: _, ...rest } = json;
      return rest;
    }
    case "waiting":
      return newer(json.state, STATES) ? { ...json, state: "working" } : json;
    case "run": {
      const body = withSource(json);
      if (!isObj(body.progress) || !newer(body.progress.unit, UNITS)) return body;
      const { progress: _, ...rest } = body;
      return rest;
    }
    case "quota": {
      const stage = (w: unknown) =>
        isObj(w) && isObj(w.pace) && newer(w.pace.stage, STAGES)
          ? { ...w, pace: { ...w.pace, stage: "unknown" } }
          : w;
      return {
        ...json,
        ...(Array.isArray(json.providers)
          ? {
              providers: json.providers.map((p) =>
                isObj(p) && Array.isArray(p.windows) ? { ...p, windows: p.windows.map(stage) } : p,
              ),
            }
          : {}),
        ...(Array.isArray(json.alerts)
          ? { alerts: json.alerts.filter((a) => !(isObj(a) && newer(a.kind, ALERT_KINDS))) }
          : {}),
      };
    }
    default:
      return json;
  }
}

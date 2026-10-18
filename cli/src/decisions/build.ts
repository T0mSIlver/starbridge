import {
  Decision,
  type DecisionLink,
  ITEM_BYTES,
  newDecisionId,
  ProtocolError,
  parseWith,
  type SealedItem,
  toWellFormed,
} from "@starbridge/protocol";
import { type Ctx, type devices, iso, UsageError } from "../context";
import { fitPicture, type Picture } from "../images";
import { seal } from "../seal";
import { type AskInput, agentOf, sourceFor } from "./source";

/** One image's file at most: its blob is then the 512 KB of base64url `BLOB_MAX` allows. */
const IMAGE_BYTES = 384 * 1024;

/**
 * A `--context` with no line break in it whose author wrote `\n` for each, as opencode's models do
 * (#1037): those become line breaks, except inside code spans and after a backslash. A context
 * that holds a real line break meant its `\n`, so it stays as typed; fenced code needs real line
 * breaks, so none is touched.
 */
export function typedBreaks(context: string): string {
  if (/[\r\n]/.test(context)) return context;
  return context
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/(?<!\\)\\n/g, "\n")))
    .join("");
}

export function buildDecision(input: AskInput, ctx: Ctx, machine: string, to: string[]): Decision {
  if (!input.question) throw new UsageError("ask needs --question");
  const options = input.options ?? [];
  const link = (l: string | DecisionLink) => (typeof l === "string" ? { url: l } : l);
  const links = (input.links ?? []).map(link);
  if (input.answerIn !== undefined && options.length > 0)
    throw new UsageError(
      "--answer-in takes no --option: the owner answers on that page, never in two places",
    );
  const decision = {
    v: 1 as const,
    id: newDecisionId(),
    to,
    // `--input` JSON can carry no Date: only the hooks set it.
    createdAt: input.askedAt instanceof Date ? input.askedAt.toISOString() : iso(ctx.now()),
    question: input.question,
    context: input.context ?? "",
    options,
    ...(options.length > 0 ? { recommended: input.recommended ?? options[0] } : {}),
    ...agentOf(input, ctx.env),
    source: sourceFor(input, ctx, machine),
    ...(links.length > 0 ? { links } : {}),
    ...(input.answerIn !== undefined ? { answerIn: link(input.answerIn) } : {}),
    ...(options.length > 0 ? { replies: true as const } : {}),
    ...(input.answerIn !== undefined ? { done: true as const } : {}),
  };
  return checked(decision);
}

/** The longest question, option and context the protocol takes, for `ask --help` (#1920). */
export const ASK_LIMITS = {
  question: Decision.shape.question.maxLength ?? 0,
  option: Decision.shape.options.element.maxLength ?? 0,
  context: Decision.shape.context.maxLength ?? 0,
};

/** The `ask` flag each field of a decision comes from, by its path with no array index. */
const FLAGS: Record<string, string> = {
  question: "--question",
  context: "--context",
  options: "--option",
  "links.url": "--link",
  "links.title": "--link",
  "answerIn.url": "--answer-in",
  "source.project": "--project",
  "source.session": "--session",
  "source.sessionTitle": "--session-title",
};

/**
 * A text too long for the protocol, said as `run` says it: the flag and its limit (#1920), not
 * the schema's own words, which name neither.
 */
function tooLong(decision: unknown): string | undefined {
  const issue = Decision.safeParse(decision).error?.issues.find(
    (i) => i.code === "too_big" && i.origin === "string",
  );
  if (issue?.code !== "too_big") return undefined;
  const flag = FLAGS[issue.path.filter((p) => typeof p === "string").join(".")];
  return flag && `${flag} takes at most ${issue.maximum} characters`;
}

function checked(decision: unknown): Decision {
  // Agents' text, cut to length, can hold a lone surrogate, which the protocol refuses (#1090).
  const wellFormed = toWellFormed(decision);
  try {
    return parseWith(Decision, wellFormed);
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    throw new UsageError(tooLong(wellFormed) ?? `bad decision: ${e.message}`);
  }
}

/** The most boxes an item holds, so the most devices a decision is ever re-sealed to. */
const MAX_BOXES = 64;

/** What one more recipient adds to a box: a 64-character id, quoted, with its comma, in base64. */
const RECIPIENT_BYTES = Math.ceil(((64 + 3) * 4) / 3);

/**
 * What the item weighs once re-sealed to as many devices as it can ever reach: its blobs once,
 * and once per device its largest box, grown by the ids its `to` gains. A re-seal sends no blobs,
 * but the server counts the ones it keeps, so a decision that fits only its first devices could
 * never reach a new one (#720).
 */
const itemBytes = (item: SealedItem) => {
  const n = item.boxes.length;
  const box = Math.max(0, ...item.boxes.map((b) => b.box.length));
  const grown = box + Math.max(0, MAX_BOXES - n) * RECIPIENT_BYTES;
  return (
    Math.max(MAX_BOXES, n) * grown + (item.blobs ?? []).reduce((total, b) => total + b.length, 0)
  );
};

/**
 * Signs and seals the decision with its pictures, scaled down until its boxes and blobs fit
 * ITEM_BYTES for every device it may be re-sealed to. Each picture is one blob, base64url,
 * whatever the number of devices (#685).
 */
export function sealWithPictures(
  base: Decision,
  pictures: Picture[],
  signer: { id: string; signKey: Uint8Array },
  to: ReturnType<typeof devices>,
): { decision: Decision; item: SealedItem } {
  const sealed = (d: Decision) => seal("decision", d, signer, to);
  if (pictures.length === 0) return { decision: base, item: sealed(base) };
  if (pictures.length > 4) throw new UsageError("--image: at most 4 images");
  let share = Math.min(
    IMAGE_BYTES,
    Math.floor(((ITEM_BYTES - itemBytes(sealed(base))) * 3) / 4 / pictures.length),
  );
  for (let tries = 0; tries < 5; tries++) {
    if (share < 1024) break;
    const fitted = pictures.map((p) => fitPicture(p, share));
    const decision = checked({ ...base, images: fitted.map((f) => f.image) });
    const item = { ...sealed(decision), blobs: fitted.map((f) => f.blob) };
    const size = itemBytes(item);
    if (size <= ITEM_BYTES) return { decision, item };
    share = Math.floor(share * (ITEM_BYTES / size) * 0.95);
  }
  throw new UsageError(
    "the images do not fit in one decision: attach fewer images, or shorten the context",
  );
}

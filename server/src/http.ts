import type { Context } from "hono";
import type { z } from "zod";
import { fail } from "./auth";
import type { Env } from "./env";

/** Parses the JSON body with `schema`, or answers 400. */
export async function json<T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    fail(400, "bad-request", "body is not JSON");
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    fail(400, "bad-schema", issue ? `${issue.path.join(".")}: ${issue.message}` : undefined);
  }
  return r.data;
}

/** The `wait` query parameter in seconds, capped by the server's limit. */
export function waitSeconds(c: Context<Env>): number {
  const raw = c.req.query("wait");
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(400, "bad-request", "wait must be a number of seconds");
  return Math.min(n, c.var.config.maxWaitSeconds);
}

/** Lets a long-poll outlive Bun's idle timeout. */
export function holdOpen(c: Context<Env>): void {
  c.env?.server?.timeout(c.req.raw, 0);
}

export function clientIp(c: Context<Env>): string {
  if (c.var.config.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    // The proxy appends the address it saw; anything to its left came from the client.
    const last = xff?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return c.env?.server?.requestIP(c.req.raw)?.address ?? "unknown";
}

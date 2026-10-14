/**
 * Deletes staging's owner account when an earlier run of an app check left one with keys, so the
 * next starts from an empty account (#1621). The iPhone app's test skips on a used account.
 *
 *   STAGING_OWNER_TOKEN=... bun demo/smoke/staging-clear.ts
 *
 * Env: STAGING_URL (https://staging.starbridge.run).
 */

export async function clearLeftover(
  server: string,
  ownerToken: string,
  log: (line: string) => void = console.log,
) {
  const call = (method: string, path: string, session?: string, body?: unknown) =>
    fetch(`${server}/v1${path}`, {
      method,
      headers: {
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signIn = await call("POST", "/auth/owner", undefined, { token: ownerToken });
  if (!signIn.ok) throw new Error(`owner sign-in on ${server}: ${signIn.status}`);
  const { session } = (await signIn.json()) as { session: string };
  const dir = await call("GET", "/directory", session);
  if (!dir.ok) throw new Error(`GET /directory: ${dir.status}`);
  const { entries } = (await dir.json()) as { entries: unknown[] };
  if (entries.length === 0) return;
  log(`deleting the owner account an earlier run left (${entries.length} directory entries)`);
  const del = await call("DELETE", "/account", session);
  if (!del.ok) throw new Error(`DELETE /account: ${del.status}`);
}

if (import.meta.main) {
  const token = process.env.STAGING_OWNER_TOKEN;
  if (!token) {
    console.error("usage: STAGING_OWNER_TOKEN=... bun demo/smoke/staging-clear.ts");
    process.exit(64);
  }
  await clearLeftover(
    (process.env.STAGING_URL ?? "https://staging.starbridge.run").replace(/\/$/, ""),
    token,
  );
}

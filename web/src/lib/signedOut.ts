// What a browser without a session shows, read without the protocol code or libsodium: the
// landing page and the sign-in screen load none of it (#1961). `known` is whether this browser
// still holds a device for the last account, which sign-in then offers to open again.
import * as store from "./store";

export async function signedOut(
  refused?: string,
): Promise<{ state: "signed-out"; known: boolean; refused?: string }> {
  const last = await store.get("current");
  return {
    state: "signed-out",
    known: !!last && !!(await store.get("device", last)),
    ...(refused ? { refused } : {}),
  };
}

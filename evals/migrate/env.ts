/**
 * The server's environment for the rehearsal: made-up keys, GitHub and the push services pointed
 * at the fakes (../load/fake.ts). Prints an env file for `docker run --env-file`.
 *
 *   bun evals/migrate/env.ts http://fake:18099 > server.env
 */
import { generateKeyPairSync } from "node:crypto";

const fake = process.argv[2];
if (!fake) throw new Error("usage: env.ts FAKE_URL");
const fcm = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const vapid = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = vapid.publicKey.export({ format: "jwk" });
const raw = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(pub.x as string, "base64url"),
  Buffer.from(pub.y as string, "base64url"),
]);
const env = {
  PUBLIC_URL: "http://localhost:18000",
  TRUST_PROXY: "1",
  ALLOW_PRIVATE_PUSH_ENDPOINTS: "1",
  GITHUB_CLIENT_ID: "rehearse",
  GITHUB_CLIENT_SECRET: "rehearse",
  GITHUB_AUTHORIZE_URL: `${fake}/login/oauth/authorize`,
  GITHUB_TOKEN_URL: `${fake}/login/oauth/access_token`,
  GITHUB_API_URL: fake,
  FCM_PROJECT_ID: "rehearse",
  FCM_CLIENT_EMAIL: "rehearse@rehearse.iam.gserviceaccount.com",
  // docker's env files take one line per variable: the key's line breaks as \n, as stack.sh writes.
  FCM_PRIVATE_KEY: (fcm as string).trim().replaceAll("\n", "\\n"),
  FCM_TOKEN_URL: `${fake}/token`,
  FCM_API_URL: fake,
  VAPID_PUBLIC_KEY: raw.toString("base64url"),
  VAPID_PRIVATE_KEY: vapid.privateKey.export({ format: "jwk" }).d as string,
  VAPID_SUBJECT: "mailto:rehearse@localhost",
};
console.log(
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
);

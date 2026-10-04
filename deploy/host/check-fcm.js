// Mints an FCM access token with the server's service account, as push.ts does, and prints
// only whether it worked. Run: deploy/host/check-fcm.sh
const now = Math.floor(Date.now() / 1000);
const tokenUrl = "https://oauth2.googleapis.com/token";
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
  iss: process.env.FCM_CLIENT_EMAIL,
  scope: "https://www.googleapis.com/auth/firebase.messaging",
  aud: tokenUrl,
  iat: now,
  exp: now + 3600,
})}`;
const pem = process.env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n");
const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
const key = await crypto.subtle.importKey(
  "pkcs8",
  der,
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(unsigned));
const res = await fetch(tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${Buffer.from(sig).toString("base64url")}`,
  }),
});
const body = await res.json();
if (!res.ok || !body.access_token) {
  console.log(`FCM token mint failed: ${res.status} ${body.error ?? ""}`);
  process.exit(1);
}
console.log(`FCM token minted for ${process.env.FCM_PROJECT_ID}, expires in ${body.expires_in} s`);

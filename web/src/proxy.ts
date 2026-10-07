import { type NextRequest, NextResponse } from "next/server";
import { origin, SESSION_COOKIE } from "@/lib/landing";

/**
 * The page's Content-Security-Policy, with a fresh nonce for each request. Next reads the nonce
 * from the request's header and puts it on its own scripts; the layout puts it on the theme
 * script. Scripts those load, such as Umami's tracker, pass through 'strict-dynamic'.
 */
function csp(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    // libsodium runs as WebAssembly; 'wasm-unsafe-eval' allows that and no JavaScript eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${dev ? "'unsafe-eval'" : "'wasm-unsafe-eval'"}`,
    // React sets style attributes, which a nonce cannot allow.
    "style-src 'self' 'unsafe-inline'",
    // Images in questions are data: URLs.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/**
 * The landing page's HTML, rendered once per origin and served to every visitor with a fresh
 * nonce (#694). Next renders on one thread, and a launch spike filled it (#593): a string copy
 * costs far less than rendering the page for each visitor. The copy renders with `PLACEHOLDER` as
 * its nonce, on a request that carries `RENDER` to tell it from a visitor's; both are this
 * process's own, so nobody else can ask for that render.
 */
const PLACEHOLDER = random();
const RENDER = random();
const RENDER_HEADER = "x-starbridge-render";
const landings = new Map<string, Promise<{ html: string; headers: Headers } | undefined>>();
/** A self-hosted server answers on a few names at most; past that, visitors get a render each. */
const ORIGINS = 4;

/** The landing page for this request, when it is a visitor's plain load of `/`. */
function landing(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return undefined;
  if (request.method !== "GET" || request.nextUrl.pathname !== "/") return undefined;
  // Signed in: the app. Back from a failed sign-in: its reason. A client navigation: Next's data.
  if (request.cookies.has(SESSION_COOKIE) || request.nextUrl.searchParams.has("signin"))
    return undefined;
  if (request.headers.has("rsc") || request.nextUrl.searchParams.has("_rsc")) return undefined;
  const base = origin(request.headers);
  let page = landings.get(base);
  if (!page) {
    if (landings.size >= ORIGINS) return undefined;
    page = render(base);
    landings.set(base, page);
    // A failed render tries again on a later visit.
    page.then((p) => p || landings.delete(base));
  }
  return page;
}

async function render(base: string) {
  const host = process.env.HOSTNAME;
  const self = `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${process.env.PORT ?? 3000}/`;
  const [proto, forwardedHost] = base.split("://");
  try {
    const res = await fetch(self, {
      headers: {
        [RENDER_HEADER]: RENDER,
        "x-forwarded-proto": proto ?? "http",
        "x-forwarded-host": forwardedHost ?? "",
      },
    });
    if (!res.ok || res.headers.has("set-cookie")) return undefined;
    const headers = new Headers(res.headers);
    for (const h of [
      "content-length",
      "content-encoding",
      "date",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "content-security-policy",
    ])
      headers.delete(h);
    return { html: await res.text(), headers };
  } catch {
    return undefined;
  }
}

export async function proxy(request: NextRequest) {
  const rendering = request.headers.get(RENDER_HEADER) === RENDER;
  const page = rendering ? undefined : await landing(request);
  const nonce = rendering ? PLACEHOLDER : random();
  const policy = csp(nonce, process.env.NODE_ENV === "development");
  if (page) {
    // Next's font preloads in the Link header carry the nonce too.
    const headers = new Headers();
    for (const [k, v] of page.headers) headers.set(k, v.replaceAll(PLACEHOLDER, nonce));
    headers.set("content-security-policy", policy);
    return new NextResponse(page.html.replaceAll(PLACEHOLDER, nonce), { headers });
  }
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  // Pages only: the API, Next's static files, the service worker and images need no policy.
  matcher: ["/((?!v1/|_next/static/|_next/image|sw\\.js|.*\\.(?:png|webp|svg|ico)).*)"],
};

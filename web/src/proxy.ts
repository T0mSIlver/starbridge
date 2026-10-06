import { type NextRequest, NextResponse } from "next/server";

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

export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = csp(nonce, process.env.NODE_ENV === "development");
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

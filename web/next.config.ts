import { join } from "node:path";
import type { NextConfig } from "next";

// The web must share the server's origin: the session cookie is SameSite=Lax and the server
// refuses cross-origin writes. In development Next proxies /v1 to the server; in production a
// reverse proxy routes /v1 there and the rest here.
const server = process.env.STARBRIDGE_SERVER ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  // Caddy compresses every response (deploy/Caddyfile). Next's own gzip runs on its one thread
  // and cost it about 40 ms of CPU per new visitor, the landing page's scripts and styles, so a
  // launch spike filled that thread near 18 visitors a second (#593).
  compress: false,
  // A self-contained server for the deploy image; tracing starts at the monorepo root.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, ".."),
  // The docs render per request, for their CSP nonce (proxy.ts), from these Markdown files.
  outputFileTracingIncludes: {
    "/docs/**": ["../docs/*.md", "../cli/README.md", "../server/README.md"],
  },
  // The protocol package ships TypeScript source.
  transpilePackages: ["@starbridge/protocol"],
  // Tests import workspace packages the deploy image leaves out; `pnpm typecheck` covers them.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${server}/v1/:path*` }];
  },
};

export default nextConfig;

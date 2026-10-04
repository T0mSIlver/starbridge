import { join } from "node:path";
import type { NextConfig } from "next";

// The web must share the server's origin: the session cookie is SameSite=Lax and the server
// refuses cross-origin writes. In development Next proxies /v1 to the server; in production a
// reverse proxy routes /v1 there and the rest here.
const server = process.env.STARBRIDGE_SERVER ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // A self-contained server for the deploy image; tracing starts at the monorepo root.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, ".."),
  // The protocol package ships TypeScript source.
  transpilePackages: ["@starbridge/protocol"],
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${server}/v1/:path*` }];
  },
};

export default nextConfig;

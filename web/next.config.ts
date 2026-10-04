import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // The protocol package ships TypeScript source.
  transpilePackages: ["@starbridge/protocol"],
};

export default nextConfig;

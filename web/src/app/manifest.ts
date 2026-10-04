import type { MetadataRoute } from "next";

// Install metadata for the web page. The icons sit on DESIGN.md's dark bg in
// both schemes, like the Android launcher icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Starbridge",
    short_name: "Starbridge",
    description: "Your AI quota windows and the decisions your agents need from you.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

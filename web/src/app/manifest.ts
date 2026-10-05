import type { MetadataRoute } from "next";

// Install metadata for the web page, the iOS and desktop app (SPEC.md, "Platforms"). The icons
// and the window colours are DESIGN.md's dark `bg`, like the Android launcher icon; the page's
// theme-color meta (layout.tsx) follows the scheme once it loads. The screenshots are dark
// copies of e2e/run.ts's shots, for Chrome's install sheet.
export default function manifest(): MetadataRoute.Manifest {
  const shot = (name: string, wide: boolean, label: string) => ({
    src: `/install/${name}-${wide ? "desktop" : "phone"}.webp`,
    sizes: wide ? (name === "inbox" ? "1280x996" : "1280x991") : "390x844",
    type: "image/webp",
    form_factor: wide ? ("wide" as const) : ("narrow" as const),
    label,
  });
  return {
    id: "/",
    name: "Starbridge",
    short_name: "Starbridge",
    description: "Your AI quota windows and the decisions your agents need from you.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0c0c0c",
    theme_color: "#0c0c0c",
    categories: ["productivity", "utilities"],
    // A launch from the icon or a shortcut reuses the open window; Shell.tsx routes it.
    launch_handler: { client_mode: ["focus-existing", "auto"] },
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Inbox", url: "/" },
      { name: "Quotas", url: "/quotas" },
    ],
    screenshots: [
      shot("inbox", true, "A decision with its options, beside the inbox"),
      shot("quotas", true, "Quota windows, each with its pace"),
      shot("inbox", false, "A decision with its options"),
      shot("quotas", false, "Quota windows, each with its pace"),
    ],
  };
}

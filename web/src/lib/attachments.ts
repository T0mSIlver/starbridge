import type { DecisionImage, DecisionLink } from "@starbridge/protocol";

/** An `<img>` source for an attached image; the protocol carries it as base64url. */
export function imageSrc(img: DecisionImage): string {
  const b64 = img.data.replace(/-/g, "+").replace(/_/g, "/");
  return `data:${img.type};base64,${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
}

/** The image as a blob, which a new tab can open where a data: URL is blocked. */
export function imageBlob(img: DecisionImage): Blob {
  const bin = atob(imageSrc(img).slice(img.type.length + 13));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: img.type });
}

/** A link's chip text: its title, else "Claude artifact" for one, else its host and path. */
export function linkLabel(link: DecisionLink): string {
  if (link.title) return link.title;
  const url = new URL(link.url);
  if (url.hostname === "claude.ai" && /\/artifacts?\//.test(url.pathname)) return "Claude artifact";
  const text = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

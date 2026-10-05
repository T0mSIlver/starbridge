"use client";

import type { DecisionImage } from "@starbridge/protocol";
import { imageBlob, imageSrc, linkLabel } from "@/lib/attachments";
import type { Decision } from "@/lib/types";
import s from "./Attachments.module.css";
import { LinkIcon } from "./icons";

/** Opens the full-size image in a new tab; browsers block opening a data: URL there. */
function openFull(img: DecisionImage) {
  const url = URL.createObjectURL(imageBlob(img));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The decision's images, side by side when there are several, so mockups compare at a glance. */
export function Images({ d }: { d: Decision }) {
  const images = d.images ?? [];
  if (images.length === 0) return null;
  return (
    <div className={`${s.images} ${images.length > 1 ? s.grid : ""}`}>
      {images.map((img, i) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: images have no id, and never reorder
          key={i}
          type="button"
          className={s.image}
          onClick={() => openFull(img)}
          title="Open full size"
        >
          {/* biome-ignore lint/performance/noImgElement: decrypted data, nothing for next/image to fetch */}
          <img src={imageSrc(img)} alt={img.alt ?? ""} width={img.width} height={img.height} />
        </button>
      ))}
    </div>
  );
}

/** The first image, small, beside a decision in the list. */
export function Thumb({ d }: { d: Decision }) {
  const img = d.images?.[0];
  if (!img) return null;
  // biome-ignore lint/performance/noImgElement: decrypted data, nothing for next/image to fetch
  return <img className={s.thumb} src={imageSrc(img)} alt="" width={40} height={40} />;
}

/** Pages the agent attached, such as a Claude artifact, as chips that open in a new tab. */
export function Links({ d }: { d: Decision }) {
  const links = d.links ?? [];
  if (links.length === 0) return null;
  return (
    <nav className={s.links} aria-label="Links">
      {links.map((l) => (
        <a key={l.url} className={s.chip} href={l.url} target="_blank" rel="noopener noreferrer">
          <LinkIcon size={18} />
          <span className="t-label">{linkLabel(l)}</span>
        </a>
      ))}
    </nav>
  );
}

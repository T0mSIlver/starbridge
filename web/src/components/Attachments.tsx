"use client";

import { useState } from "react";
import { githubRef, imageSrc, linkLabel } from "@/lib/attachments";
import type { Decision } from "@/lib/types";
import s from "./Attachments.module.css";
import { Icon } from "./icons";
import { Viewer } from "./Viewer";

/** The decision's images, side by side when there are several; each opens the viewer. */
export function Images({ d }: { d: Decision }) {
  const images = d.images ?? [];
  const [open, setOpen] = useState<number>();
  if (images.length === 0) return null;
  return (
    <div className={`${s.images} ${images.length > 1 ? s.grid : ""}`}>
      {images.map((img, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: images have no id, and never reorder
        <ImageButton key={i} img={img} onOpen={() => setOpen(i)} />
      ))}
      {open !== undefined && (
        <Viewer images={images} start={open} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}

/** One image, opening the viewer; the inset colour bands it where its shape leaves room. */
export function ImageButton({
  img,
  onOpen,
  className = "",
}: {
  img: NonNullable<Decision["images"]>[number];
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`${s.image} ${className}`}
      onClick={onOpen}
      aria-label={img.alt ? `View ${img.alt}` : "View image"}
    >
      {/* biome-ignore lint/performance/noImgElement: decrypted data, nothing for next/image to fetch */}
      <img src={imageSrc(img)} alt={img.alt ?? ""} width={img.width} height={img.height} />
      {/* Says the image opens full screen; touch screens show no zoom cursor (#170). */}
      <span className={s.expand}>
        <Icon name="expand" size={20} />
      </span>
    </button>
  );
}

/**
 * Pages the agent attached for the owner to see before answering, such as a Claude artifact it
 * built (SPEC.md, "Questions"): labelled as the agent's, each opening a new tab. A
 * GitHub pull request or issue leads with the GitHub mark.
 */
export function Links({ d }: { d: Decision }) {
  const links = d.links ?? [];
  if (links.length === 0) return null;
  return (
    <nav className={s.links} aria-labelledby={`links-${d.id}`}>
      <span id={`links-${d.id}`} className={`t-caption ${s.linksLabel}`}>
        Attached by the agent
      </span>
      {links.map((l) => (
        <a key={l.url} className={s.chip} href={l.url} target="_blank" rel="noopener noreferrer">
          {githubRef(l.url) && <Icon name="github" size={16} />}
          <span className="t-label">Open {linkLabel(l)}</span>
          <Icon name="open" size={16} />
        </a>
      ))}
    </nav>
  );
}

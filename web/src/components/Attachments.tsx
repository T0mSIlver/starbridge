"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import { githubLink, imageSrc, linkLabel } from "@/lib/attachments";
import type { Decision } from "@/lib/types";
import s from "./Attachments.module.css";
import { Icon, Octicon } from "./icons";
import { Viewer } from "./Viewer";

type Image = NonNullable<Decision["images"]>[number];

/** Indexes of `n` images in rows of two, in order. */
export const rows = (n: number) =>
  Array.from({ length: Math.ceil(n / 2) }, (_, r) => [2 * r, 2 * r + 1].filter((i) => i < n));

/** The decision's images, two to a row; each opens the viewer. */
export function Images({ d }: { d: Decision }) {
  const images = d.images ?? [];
  const [open, setOpen] = useState<number>();
  if (images.length === 0) return null;
  return (
    <div className={s.images}>
      {rows(images.length).map((row) => (
        <ImageRow key={row[0]} images={row.map((i) => images[i])}>
          {row.map((i) => (
            <ImageButton key={i} img={images[i]} onOpen={() => setOpen(i)} />
          ))}
        </ImageRow>
      ))}
      {open !== undefined && (
        <Viewer images={images} start={open} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}

/**
 * A row of images at one height, each as wide as its shape asks, together filling the row (#536):
 * no image is banded or cropped. The row is at most `--row-max` tall, narrower when that caps it.
 */
export function ImageRow({ images, children }: { images: Image[]; children: ReactNode }) {
  const shape = images.reduce((sum, i) => sum + i.width / i.height, 0);
  const style = { "--shape": shape, "--n": images.length } as CSSProperties;
  return (
    <div className={s.row} style={style}>
      {children}
    </div>
  );
}

/** One image at its own shape, opening the viewer. */
export function ImageButton({
  img,
  onOpen,
  className = "",
}: {
  img: Image;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`${s.image} ${className}`}
      style={{ "--r": img.width / img.height } as CSSProperties}
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
 * built (SPEC.md, "Questions"), each opening a new tab. A GitHub link leads with its kind's
 * Octicon and reads as its reference, "#123" (#971).
 */
export function Links({ d }: { d: Decision }) {
  const links = d.links ?? [];
  if (links.length === 0) return null;
  return (
    <nav className={s.links} aria-label="Links from the agent">
      {links.map((l) => {
        const gh = githubLink(l.url);
        return (
          <a
            key={l.url}
            className={s.chip}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            title={l.title ?? l.url}
          >
            {gh && <Octicon kind={gh.kind} />}
            <span className="t-label">{linkLabel(l, d.source.project)}</span>
            <Icon name="open" size={16} />
          </a>
        );
      })}
    </nav>
  );
}

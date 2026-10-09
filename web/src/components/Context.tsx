// A decision's context in the subset every client renders (#969): one block per line, bullets
// and numbers with a hanging indent, bold, links, and code inline or fenced. Code is the only
// text set in mono (DESIGN.md); anything else shows as typed.
import { type Block, parseContext, type Span } from "@starbridge/protocol/context";
import type { ReactNode } from "react";
import s from "./Context.module.css";

function Spans({ spans }: { spans: Span[] }) {
  // biome-ignore-start lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
  return spans.map((span, i) => {
    let node: ReactNode = span.text;
    if (span.code) node = <code className={`t-code ${s.inline}`}>{node}</code>;
    if (span.href)
      node = (
        <a href={span.href} target="_blank" rel="noreferrer">
          {node}
        </a>
      );
    return span.bold ? <strong key={i}>{node}</strong> : <span key={i}>{node}</span>;
  });
  // biome-ignore-end lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
}

function Line({ block }: { block: Block }) {
  if (block.kind === "code")
    return (
      <pre className={`t-code ${s.block}`}>
        <code>{block.text}</code>
      </pre>
    );
  if (block.kind === "line")
    return (
      <p>
        <Spans spans={block.spans} />
      </p>
    );
  return (
    <p className={s.item} data-marker={block.kind === "number" ? block.marker : "•"}>
      <Spans spans={block.spans} />
    </p>
  );
}

export function Context({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`${s.context} ${className ?? ""}`}>
      {parseContext(text).map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one fixed string, never reordered
        <Line key={i} block={block} />
      ))}
    </div>
  );
}

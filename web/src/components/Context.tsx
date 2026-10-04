// A decision's context: plain text with links, inline `code` and fenced code
// blocks. Code is the only text set in mono (DESIGN.md).
import s from "./Context.module.css";

const FENCE = /```[^\n]*\n?([\s\S]*?)```/;
const INLINE = /(`[^`\n]+`|https?:\/\/\S+)/;

function Inline({ text }: { text: string }) {
  return text.split(INLINE).map((part, i) => {
    // biome-ignore-start lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
    if (/^`.+`$/.test(part))
      return (
        <code key={i} className={`t-code ${s.inline}`}>
          {part.slice(1, -1)}
        </code>
      );
    if (/^https?:\/\//.test(part))
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer">
          {part.replace(/^https?:\/\//, "")}
        </a>
      );
    // biome-ignore-end lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
    return part;
  });
}

export function Context({ text, className }: { text: string; className?: string }) {
  const blocks: React.ReactNode[] = [];
  let rest = text;
  for (let match = FENCE.exec(rest); match; match = FENCE.exec(rest)) {
    const before = rest.slice(0, match.index).trim();
    if (before) blocks.push(<p key={blocks.length}>{<Inline text={before} />}</p>);
    blocks.push(
      <pre key={blocks.length} className={`t-code ${s.block}`}>
        <code>{(match[1] ?? "").replace(/\n$/, "")}</code>
      </pre>,
    );
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest.trim()) blocks.push(<p key={blocks.length}>{<Inline text={rest.trim()} />}</p>);
  return <div className={`${s.context} ${className ?? ""}`}>{blocks}</div>;
}

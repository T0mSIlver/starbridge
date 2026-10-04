// A decision's context: plain text with links, inline `code` and fenced code
// blocks. Code is the only text set in mono (DESIGN.md).
import s from "./Context.module.css";

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

type Part = { code: boolean; text: string; line: number };

// Fences open and close only on a line that starts with ```; an unclosed
// fence runs to the end, as in CommonMark.
function split(text: string): Part[] {
  const parts: Part[] = [];
  let code = false;
  let lines: string[] = [];
  let start = 0;
  const flush = (next: number) => {
    const body = lines.join("\n");
    if (code || body.trim()) parts.push({ code, text: code ? body : body.trim(), line: start });
    lines = [];
    start = next;
  };
  text.split("\n").forEach((line, n) => {
    if (line.trimStart().startsWith("```")) {
      flush(n + 1);
      code = !code;
    } else lines.push(line);
  });
  flush(0);
  return parts;
}

export function Context({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`${s.context} ${className ?? ""}`}>
      {split(text).map((part) =>
        part.code ? (
          <pre key={part.line} className={`t-code ${s.block}`}>
            <code>{part.text}</code>
          </pre>
        ) : (
          <p key={part.line}>
            <Inline text={part.text} />
          </p>
        ),
      )}
    </div>
  );
}

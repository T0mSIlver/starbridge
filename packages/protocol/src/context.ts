// A decision's context as every client shows it (#969): the small Markdown subset agents may rely
// on, parsed once here and ported to Kotlin, with packages/protocol/vectors/context.json keeping
// the two in step. Anything outside the subset shows as typed. It imports nothing, so the web's
// service worker takes it from "@starbridge/protocol/context" without the crypto.

/** A run of text with one style: code, bold, a link, or plain. Bold may wrap code or a link. */
export type Span = { text: string; code?: true; bold?: true; href?: string };

/**
 * One line of the context, or one fenced code block. Each line is its own block, so an agent's
 * line per option reads as one; blank lines only separate.
 */
export type Block =
  | { kind: "line"; spans: Span[] }
  | { kind: "bullet"; spans: Span[] }
  | { kind: "number"; marker: string; spans: Span[] }
  | { kind: "code"; text: string };

// Leftmost match wins; at one position, code before a link before bold before a bare URL.
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)([^\n]*?\S)\*\*|(https?:\/\/[^\s<>]+)/g;
// What ends a sentence rather than a URL: "see https://x.dev/a." links https://x.dev/a.
const URL_TAIL = /[.,;:!?'")\]]+$/;

function inline(text: string, bold = false): Span[] {
  const spans: Span[] = [];
  const push = (span: Span) => {
    if (!span.text) return;
    const s: Span = bold ? { ...span, bold: true } : span;
    const last = spans[spans.length - 1];
    if (last && !s.code && !s.href && !last.code && !last.href && last.bold === s.bold)
      last.text += s.text;
    else spans.push(s);
  };
  const re = new RegExp(INLINE);
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    let end = start + m[0].length;
    push({ text: text.slice(at, start) });
    if (m[1] !== undefined) push({ text: m[1], code: true });
    else if (m[2] !== undefined && m[3] !== undefined) push({ text: m[2], href: m[3] });
    else if (m[4] !== undefined) for (const s of inline(m[4], true)) push(s);
    else {
      const url = m[0].replace(URL_TAIL, "");
      end = start + url.length;
      push({ text: url.replace(/^https?:\/\//, ""), href: url });
    }
    // A trimmed tail goes back to the text after it.
    at = end;
    re.lastIndex = end;
  }
  push({ text: text.slice(at) });
  return spans;
}

const BULLET = /^[-*•]\s+(.*)$/;
const NUMBER = /^([0-9]{1,3})[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Fences open and close on a line starting with ```; an unclosed one runs to the end. */
export function parseContext(text: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | null = null;
  const close = () => {
    const body = code?.join("\n").replace(/\s+$/, "") ?? "";
    if (body) blocks.push({ kind: "code", text: body });
    code = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      if (code) close();
      else code = [];
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    const b = BULLET.exec(line);
    const n = NUMBER.exec(line);
    const h = HEADING.exec(line);
    if (b) blocks.push({ kind: "bullet", spans: inline(b[1] ?? "") });
    else if (n) blocks.push({ kind: "number", marker: `${n[1]}.`, spans: inline(n[2] ?? "") });
    // A heading is a bold line: a card has no room for sizes.
    else if (h) blocks.push({ kind: "line", spans: inline(h[1] ?? "", true) });
    else blocks.push({ kind: "line", spans: inline(line) });
  }
  close();
  return blocks;
}

/** The context as plain lines, for a notification, which shows no formatting. */
export function contextText(text: string): string {
  return parseContext(text)
    .map((b) => {
      if (b.kind === "code") return b.text;
      const words = b.spans.map((s) => s.text).join("");
      return b.kind === "bullet"
        ? `• ${words}`
        : b.kind === "number"
          ? `${b.marker} ${words}`
          : words;
    })
    .join("\n");
}

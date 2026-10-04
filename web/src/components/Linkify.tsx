// Context may carry links (SPEC.md); everything else stays text.
export function Linkify({ text }: { text: string }) {
  return text.split(/(https?:\/\/\S+)/).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part.replace(/^https?:\/\//, "")}
      </a>
    ) : (
      part
    ),
  );
}

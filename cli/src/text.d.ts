/** Markdown files imported as text (`with { type: "text" }`), which Bun bundles. */
declare module "*.md" {
  const text: string;
  export default text;
}

/** Markdown files imported as text (`with { type: "text" }`), which Bun bundles. */
declare module "*.md" {
  const text: string;
  export default text;
}

/** Shell scripts imported as text, which setup writes into other tools. */
declare module "*.sh" {
  const text: string;
  export default text;
}

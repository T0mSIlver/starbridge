/** `s` as one word in a POSIX shell line: single quotes, with a quote inside as `'\''`. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `s` as one word in a fish line, whose single quotes take `\'` and `\\` as escapes. */
export const fishQuote = (s: string) => `'${s.replace(/[\\']/g, "\\$&")}'`;

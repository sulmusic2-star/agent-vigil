/** Render untrusted text as a Markdown code span without relying on backslash
 * escaping. CommonMark code spans use a delimiter longer than every run of
 * backticks in the value, so the value cannot terminate the span. */
export function markdownCodeSpan(input: string): string {
  const value = input.replace(/[\r\n]+/g, " ");
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  const padded = value.startsWith("`") || value.endsWith("`") || value.startsWith(" ") || value.endsWith(" ");
  return padded ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

/** Escape a single Markdown table cell. Backslashes must be escaped before
 * pipes so an existing backslash cannot neutralize the pipe escape. */
export function markdownTableCell(input: string): string {
  return input
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}


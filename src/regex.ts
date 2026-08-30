/** Escape an arbitrary literal for interpolation into a RegExp source. */
export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


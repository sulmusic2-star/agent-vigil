const TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

/** Render untrusted text without allowing it to control or invisibly reorder a terminal. */
export function terminalSafe(value: string): string {
  return value.replace(TERMINAL_UNSAFE, (character) => {
    const codePoint = character.codePointAt(0);
    return `\\u{${(codePoint ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

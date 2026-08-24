const SAFE_OPTION_NAME = /^--[a-z][a-z0-9-]{0,63}$/;

/**
 * Return only a conservative CLI option name for diagnostics.
 *
 * Values attached with `=` are intentionally discarded before validation. If
 * the remaining token is not a normal option name, return a fixed placeholder
 * rather than reflecting attacker-controlled terminal text or secret material.
 */
export function safeArgLabel(argument: string): string {
  const equals = argument.indexOf("=");
  const candidate = equals === -1 ? argument : argument.slice(0, equals);
  return SAFE_OPTION_NAME.test(candidate) ? candidate : "--option";
}

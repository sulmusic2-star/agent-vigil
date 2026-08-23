import { safeArgLabel } from "./cli-arguments.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

const SAFE_CLI_DIAGNOSTIC = Symbol("safe-cli-diagnostic");

/**
 * A diagnostic whose complete text was assembled from fixed prose and a
 * conservatively validated option name. Arbitrary Error messages must never
 * cross the CLI presentation boundary: filesystem, parser, Git, and runtime
 * errors commonly contain caller-controlled paths, refs, URLs, or source text.
 */
class SafeCliDiagnostic extends Error {
  readonly [SAFE_CLI_DIAGNOSTIC] = true;
}

function safe(message: string): SafeCliDiagnostic {
  return new SafeCliDiagnostic(message);
}

export function unknownOptionError(argument: string): Error {
  return safe(`unknown option: ${safeArgLabel(argument)}`);
}

export function optionRequiresValueError(argument: string): Error {
  return safe(`${safeArgLabel(argument)} requires a value`);
}

export function duplicateOptionError(argument: string): Error {
  return safe(`duplicate option: ${safeArgLabel(argument)}`);
}

export function optionOnlyOnceError(argument: string): Error {
  return safe(`${safeArgLabel(argument)} may be supplied only once`);
}

export function unexpectedPositionalError(): Error {
  return safe("unexpected positional argument");
}

export function unknownUpgradeCommandError(): Error {
  return safe("unknown upgrade command");
}

export function portableSigningKeyError(): Error {
  return safe("--portable-output requires --signing-key");
}

export function missingTranscriptError(): Error {
  return safe("a transcript or configured transcript is required");
}

export function transcriptUnavailableError(): Error {
  return safe("transcript not found");
}

export function repositoryUnavailableError(): Error {
  return safe("repository not found");
}

export function invalidGitRangeError(): Error {
  return safe("invalid git range");
}

export function receiptIntegrityError(): Error {
  return safe("receipt does not match receiptHash");
}

export function fleetDeploymentIntentRequiredError(): Error {
  return safe("upgrade enforce requires one entry, --policy, --public-key, and all four trusted --expected-* deployment intent values");
}

function diagnostic(error: unknown): string {
  // The symbol check makes subclass spoofing through an arbitrary Error
  // message insufficient; only errors constructed inside this module retain
  // their bounded text. Everything else is intentionally fail-closed.
  if (error instanceof SafeCliDiagnostic && error[SAFE_CLI_DIAGNOSTIC] === true) {
    return terminalSafe(error.message);
  }
  return "operation failed";
}

/** Present a CLI failure without reflecting any untrusted exception text. */
export function reportCliError(prefix: "agent-vigil" | "agent-vigil upgrade", error: unknown): number {
  console.error(`${prefix}: ${diagnostic(error)}`);
  return 2;
}

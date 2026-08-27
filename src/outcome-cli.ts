import { resolve } from "node:path";
import { publicKeyId } from "./signature.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";
import { terminalSafe } from "./upgrade/presentation.ts";
import {
  assessOutcome,
  buildSettlementAdapterPayload,
  createOutcomeMandate,
  loadOutcomeJson,
  verifyOutcomeMandate,
  verifyOutcomeReceipt,
  type OutcomeAdapter,
  type OutcomeReceipt,
} from "./outcome.ts";

type Parsed = {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
};

function parse(args: string[], valueOptions: Set<string>, flagOptions = new Set<string>()): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (flagOptions.has(arg)) { flags.add(arg); continue; }
    if (!valueOptions.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (values.has(arg)) throw new Error(`${arg} may be supplied only once`);
    values.set(arg, value);
    index += 1;
  }
  return { positional, values, flags };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function positiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error("comma-separated values must not be empty");
  return values;
}

function adapter(value: string | undefined): OutcomeAdapter {
  const selected = value ?? "generic";
  if (!new Set(["generic", "a2a", "ap2", "x402", "erc-8004", "vcap"]).has(selected)) throw new Error("--adapter must be generic, a2a, ap2, x402, erc-8004, or vcap");
  return selected as OutcomeAdapter;
}

const UNSAFE_JSON_CODE_POINT = /[\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNSAFE_JSON_CODE_POINT, (character) => {
    // Use the shared presentation policy to classify/render the code point,
    // then translate that marker to JSON escapes so parsing preserves the
    // original value while the terminal never receives the raw control text.
    const rendered = terminalSafe(character);
    const match = /^\\u\{([0-9A-F]+)\}$/.exec(rendered);
    if (!match) return rendered;
    const codePoint = Number.parseInt(match[1], 16);
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16).toUpperCase()}\\u${low.toString(16).toUpperCase()}`;
  });
}

function writeJson(path: string | undefined, value: unknown): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (path) writePrivateFileAtomic(resolve(path), json);
  else console.log(terminalSafeJson(value));
}

function printVerification(label: string, result: ReturnType<typeof verifyOutcomeMandate>): void {
  console.log([`${terminalSafe(label)}: ${result.valid ? "VALID" : "INVALID"}`, `Hash: ${result.hashValid ? "valid" : "invalid"}`, `Signature: ${result.signatureValid ? "valid" : "invalid"}`, `Key pinned: ${result.keyPinned ? "yes" : "no"}`].join("\n"));
  for (const line of [...(result.expired ? ["Expired: yes"] : []), ...result.errors.map((error) => `- ${terminalSafe(error)}`)]) console.log(line);
}

function errorMessage(error: unknown): string {
  return terminalSafe(error instanceof Error ? error.message : String(error));
}

export function outcomeUsage(): string {
  return `Outcome commands:
  vigil mandate create --requester <id> --task-id <id> --task-class <name> --description <text> --base <sha> --head <sha> --expires <time> --requester-key <private.pem> --verifier-public-key <public.pem> --output <mandate.json> [options]
  vigil mandate verify <mandate.json> [--requester-public-key <public.pem>] [--as-of <time>]
  vigil mandate assess <mandate.json> --receipt <agent-vigil-receipt.json> --verifier-key <private.pem> --requester-public-key <public.pem> --output <outcome-receipt.json> --attempts <n> [--cost-usd <amount>] [--issued-at <time>]
  vigil receipt verify <outcome-receipt.json> [--verifier-public-key <public.pem>] [--trusted-key-ids <sha256:...,...>]
  vigil receipt signal <outcome-receipt.json> (--verifier-public-key <public.pem> | --trusted-key-ids <ids>) [--adapter generic|a2a|ap2|x402|erc-8004|vcap] [--output <signal.json>]

Mandate options:
  --provider <id>                  Optional provider-agent identity
  --required-rules <id,id>        Rule IDs that must be independently verified
  --min-verified <n>              Minimum meaningful verified claims (default: 1)
  --require-signed-evidence       Require a signed Agent Vigil trust report
  --evidence-key-ids <ids>        Trusted evidence signer key IDs
  --max-attempts <n>              Maximum attempts recorded by the agreement (default: 3)
  --max-budget-usd <amount>       Optional predeclared budget ceiling
  --adapter <name>                Draft signal adapter; no network action (default: generic)
  --settlement-ref <value>        External escrow, task, or payment reference

All settlement output is signal-only, dry-run JSON. These commands never move money.`;
}

export function runMandateCommand(args: string[]): number {
  try {
    if (args.includes("--help")) {
      console.log(outcomeUsage());
      return 0;
    }
    const command = args[0];
    if (command === "create") {
      const parsed = parse(args.slice(1), new Set([
        "--requester", "--provider", "--task-id", "--task-class", "--description", "--base", "--head", "--expires",
        "--requester-key", "--verifier-public-key", "--required-rules", "--min-verified", "--evidence-key-ids",
        "--max-attempts", "--max-budget-usd", "--adapter", "--settlement-ref", "--output", "--created-at",
      ]), new Set(["--require-signed-evidence"]));
      if (parsed.positional.length) throw new Error("mandate create does not accept positional arguments");
      const verifierPublicKey = required(parsed, "--verifier-public-key");
      const mandate = createOutcomeMandate({
        createdAt: parsed.values.get("--created-at"),
        expiresAt: required(parsed, "--expires"),
        requesterId: required(parsed, "--requester"),
        providerId: parsed.values.get("--provider"),
        taskId: required(parsed, "--task-id"),
        taskClass: required(parsed, "--task-class"),
        description: required(parsed, "--description"),
        base: required(parsed, "--base"),
        head: required(parsed, "--head"),
        minMeaningfulVerified: positiveInteger(parsed.values.get("--min-verified"), "--min-verified", 1),
        requiredRuleIds: csv(parsed.values.get("--required-rules")),
        requireSignedEvidence: parsed.flags.has("--require-signed-evidence"),
        trustedEvidenceSignerKeyIds: csv(parsed.values.get("--evidence-key-ids")),
        maxAttempts: positiveInteger(parsed.values.get("--max-attempts"), "--max-attempts", 3),
        maxBudgetUsd: positiveNumber(parsed.values.get("--max-budget-usd"), "--max-budget-usd"),
        verifierKeyIds: [publicKeyId(resolve(verifierPublicKey))],
        adapter: adapter(parsed.values.get("--adapter")),
        settlementReference: parsed.values.get("--settlement-ref"),
      }, resolve(required(parsed, "--requester-key")));
      writeJson(required(parsed, "--output"), mandate);
      console.log(`Outcome mandate created: ${terminalSafe(mandate.mandateId)}`);
      console.log(`Trusted verifier: ${terminalSafe(mandate.verifier.trustedKeyIds[0])}`);
      console.log("Settlement mode: signal-only; no network action was performed.");
      return 0;
    }
    if (command === "verify") {
      const parsed = parse(args.slice(1), new Set(["--requester-public-key", "--as-of"]));
      if (parsed.positional.length !== 1) throw new Error("mandate verify requires exactly one mandate JSON path");
      const asOfValue = parsed.values.get("--as-of");
      const asOf = asOfValue ? new Date(asOfValue) : new Date();
      if (!Number.isFinite(asOf.getTime())) throw new Error("--as-of must be an RFC3339-compatible timestamp");
      const result = verifyOutcomeMandate(loadOutcomeJson(resolve(parsed.positional[0])), parsed.values.get("--requester-public-key") ? resolve(parsed.values.get("--requester-public-key")!) : undefined, asOf);
      printVerification("Outcome mandate", result);
      return result.valid ? 0 : result.expired ? 1 : 1;
    }
    if (command === "assess") {
      const parsed = parse(args.slice(1), new Set(["--receipt", "--verifier-key", "--requester-public-key", "--issued-at", "--attempts", "--cost-usd", "--output"]));
      if (parsed.positional.length !== 1) throw new Error("mandate assess requires exactly one mandate JSON path");
      const outcome = assessOutcome(
        loadOutcomeJson(resolve(parsed.positional[0])),
        loadOutcomeJson(resolve(required(parsed, "--receipt"))),
        resolve(required(parsed, "--verifier-key")),
        {
          requesterPublicKeyPath: resolve(required(parsed, "--requester-public-key")),
          ...(parsed.values.get("--issued-at") ? { issuedAt: parsed.values.get("--issued-at")! } : {}),
          attempts: Number(required(parsed, "--attempts")),
          ...(parsed.values.has("--cost-usd") ? { costUsd: Number(parsed.values.get("--cost-usd")) } : {}),
        },
      );
      writeJson(required(parsed, "--output"), outcome);
      console.log(`Outcome: ${terminalSafe(outcome.verdict)}`);
      console.log(`Settlement signal: ${terminalSafe(outcome.settlementSignal.action)} (${terminalSafe(outcome.settlementSignal.adapter)}, dry run)`);
      console.log(`Receipt: ${terminalSafe(outcome.outcomeHash)}`);
      return outcome.verdict === "PASS" ? 0 : outcome.verdict === "FAIL" ? 1 : 2;
    }
    throw new Error(`unknown mandate command: ${command ?? "<missing>"}`);
  } catch (error) {
    console.error(`agent-vigil: ${errorMessage(error)}\n\n${outcomeUsage()}`);
    return 2;
  }
}

export function runOutcomeReceiptCommand(args: string[]): number {
  try {
    if (args.includes("--help")) {
      console.log(outcomeUsage());
      return 0;
    }
    const command = args[0];
    if (command === "verify") {
      const parsed = parse(args.slice(1), new Set(["--verifier-public-key", "--trusted-key-ids"]));
      if (parsed.positional.length !== 1) throw new Error("receipt verify requires exactly one outcome receipt JSON path");
      const input = loadOutcomeJson(resolve(parsed.positional[0])) as OutcomeReceipt;
      const result = verifyOutcomeReceipt(
        input,
        parsed.values.get("--verifier-public-key") ? resolve(parsed.values.get("--verifier-public-key")!) : undefined,
        csv(parsed.values.get("--trusted-key-ids")),
      );
      printVerification("Outcome receipt", result);
      if (!result.valid) return 1;
      console.log(`Verdict: ${terminalSafe(input.verdict)}`);
      console.log(`Signal: ${terminalSafe(input.settlementSignal.action)} (${terminalSafe(input.settlementSignal.adapter)}, dry run)`);
      return input.verdict === "PASS" ? 0 : input.verdict === "FAIL" ? 1 : 2;
    }
    if (command === "signal") {
      const parsed = parse(args.slice(1), new Set(["--adapter", "--output", "--verifier-public-key", "--trusted-key-ids"]));
      if (parsed.positional.length !== 1) throw new Error("receipt signal requires exactly one outcome receipt JSON path");
      const verifierPublicKey = parsed.values.get("--verifier-public-key");
      const trustedKeyIds = csv(parsed.values.get("--trusted-key-ids"));
      if (!verifierPublicKey && !trustedKeyIds.length) throw new Error("receipt signal requires --verifier-public-key or --trusted-key-ids");
      const signal = buildSettlementAdapterPayload(
        loadOutcomeJson(resolve(parsed.positional[0])),
        parsed.values.get("--adapter") ? adapter(parsed.values.get("--adapter")) : undefined,
        { ...(verifierPublicKey ? { verifierPublicKeyPath: resolve(verifierPublicKey) } : {}), ...(trustedKeyIds.length ? { trustedKeyIds } : {}) },
      );
      writeJson(parsed.values.get("--output"), signal);
      if (parsed.values.get("--output")) console.log(`Draft signal written to ${terminalSafe(resolve(parsed.values.get("--output")!))}. No network action was performed.`);
      return 0;
    }
    throw new Error(`unknown receipt command: ${command ?? "<missing>"}`);
  } catch (error) {
    console.error(`agent-vigil: ${errorMessage(error)}\n\n${outcomeUsage()}`);
    return 2;
  }
}

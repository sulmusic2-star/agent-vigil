import { resolve } from "node:path";
import { writePrivateFileAtomic } from "./safe-output.ts";
import { readBoundedJson } from "./upgrade/contracts.ts";
import { VERSION } from "./report.ts";
import {
  PUBLIC_PR_RECEIPT_SCHEMA,
  buildPublicPrReceipt,
  collectPublicPrSnapshot,
  renderPublicPrReceipt,
  signPublicPrReceipt,
  validateToolCommit,
  verifyPublicPrReceipt,
  type PublicPrReceipt,
  type PublicPrTransport,
} from "./public-pr-receipt.ts";

type Parsed = {
  positional: string[];
  values: Map<string, string>;
};

const VALUE_FLAGS = new Set(["--tool-ref", "--signing-key", "--output", "--format", "--as-of", "--max-age-hours"]);

function usage(): string {
  return `Agent Vigil public PR receipt — no workflow change required

Usage:
  vigil pr-receipt <https://github.com/owner/repo/pull/number> --tool-ref <full-commit-sha> [--signing-key <private.pem>] [--output <receipt.json>] [--format text|json]
  vigil pr-receipt verify <receipt.json> [--format text|json]

Options:
  --tool-ref <sha>       Required full Agent Vigil commit SHA; tags and branches are rejected
  --signing-key <path>  Optional customer-controlled Ed25519 key; the key never leaves this process
  --output <path>       Write the normalized receipt; raw GitHub responses are not retained
  --format <kind>       text or json (default: text)
  --as-of <time>        Canonical RFC3339 UTC observation time (default: now)
  --max-age-hours <n>   Freshness window for otherwise-current evidence (default: 168)

Network boundary:
  Read-only requests go only to api.github.com. No source, prompts, transcripts, or request bodies are sent or retained.

Exit codes: 0 CURRENT · 1 REVOKED · 2 usage/network error · 3 HOLD · 4 EXPIRED`;
}

function selectedReceipt(value: unknown): PublicPrReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("public PR receipt must be a JSON object");
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== PUBLIC_PR_RECEIPT_SCHEMA) throw new Error(`public PR receipt must use ${PUBLIC_PR_RECEIPT_SCHEMA}`);
  if (typeof receipt.receiptHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.receiptHash)) throw new Error("public PR receipt hash is invalid");
  if (receipt.signature !== undefined && (!receipt.signature || typeof receipt.signature !== "object" || Array.isArray(receipt.signature))) {
    throw new Error("public PR receipt signature is invalid");
  }
  return value as PublicPrReceipt;
}

function verifyReceipt(path: string, format: string): number {
  const receipt = selectedReceipt(readBoundedJson(resolve(path), 2 * 1024 * 1024, "public PR receipt"));
  const result = verifyPublicPrReceipt(receipt);
  const signaturePresent = receipt.signature !== undefined;
  const accepted = result.hashValid && (!signaturePresent || result.signatureValid === true);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ accepted, signaturePresent, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write([
      "Agent Vigil public PR receipt verification",
      "",
      `Result: ${accepted ? "VALID" : "INVALID"}`,
      `Content hash: ${result.hashValid ? "VALID" : "INVALID"}`,
      `Signature: ${signaturePresent ? result.signatureValid ? "VALID" : "INVALID" : "NOT PRESENT"}`,
      `Signer: ${result.keyId ?? "UNPINNED"}`,
      "",
    ].join("\n"));
  }
  return accepted ? 0 : 1;
}

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      if (values.has(arg)) throw new Error(`${arg} may be provided only once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) throw new Error(`unknown pr-receipt option: ${arg}`);
    else positional.push(arg);
  }
  return { positional, values };
}

function selectedTime(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error("--as-of must be canonical RFC3339 UTC");
  return value;
}

function selectedAge(value: string | undefined): number {
  if (!value) return 168;
  const selected = Number(value);
  if (!Number.isFinite(selected) || selected <= 0 || selected > 24 * 365) throw new Error("--max-age-hours must be greater than zero and no more than one year");
  return selected;
}

export async function runPublicPrReceiptCommand(
  args: string[],
  options: { transport?: PublicPrTransport; token?: string; toolVersion?: string } = {},
): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  try {
    const parsed = parse(args);
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
    if (parsed.positional[0] === "verify") {
      if (parsed.positional.length !== 2) throw new Error("pr-receipt verify requires exactly one receipt JSON path");
      for (const flag of ["--tool-ref", "--signing-key", "--output", "--as-of", "--max-age-hours"]) {
        if (parsed.values.has(flag)) throw new Error(`${flag} is not valid with pr-receipt verify`);
      }
      return verifyReceipt(parsed.positional[1], format);
    }
    if (parsed.positional.length !== 1) throw new Error("pr-receipt requires exactly one public GitHub pull request URL");
    const toolCommit = validateToolCommit(parsed.values.get("--tool-ref") ?? "");
    const signingKey = parsed.values.get("--signing-key");
    const output = parsed.values.get("--output");
    if (signingKey && output && resolve(signingKey) === resolve(output)) throw new Error("--output must not replace the signing key");
    const snapshot = await collectPublicPrSnapshot(parsed.positional[0], {
      ...(options.transport ? { transport: options.transport } : {}),
      token: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    let receipt = buildPublicPrReceipt(snapshot, parsed.positional[0], {
      generatedAt: selectedTime(parsed.values.get("--as-of")),
      maxAgeHours: selectedAge(parsed.values.get("--max-age-hours")),
      toolVersion: options.toolVersion ?? VERSION,
      toolCommit,
    });
    if (signingKey) receipt = signPublicPrReceipt(receipt, resolve(signingKey));
    if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(format === "json" ? `${JSON.stringify(receipt, null, 2)}\n` : renderPublicPrReceipt(receipt));
    if (receipt.decision.continuity === "CURRENT") return 0;
    if (receipt.decision.continuity === "REVOKED") return 1;
    if (receipt.decision.continuity === "HOLD") return 3;
    return 4;
  } catch (error) {
    console.error(`agent-vigil: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

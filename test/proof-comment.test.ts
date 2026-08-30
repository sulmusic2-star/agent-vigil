import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { PROOF_COMMENT_MARKER, renderProofComment } from "../src/proof-comment.ts";
import { buildReport, type CheckResult } from "../src/report.ts";

function check(ruleId: string, verdict: CheckResult["verdict"], kind: CheckResult["claim"]["kind"] = "integrity", evidence = "private detail"): CheckResult {
  return {
    claim: { kind, quote: "measured claim", subject: "structured finding" },
    verdict,
    evidence,
    ruleId,
  };
}

function report(results: CheckResult[], base = "a".repeat(40)) {
  return buildReport({
    transcript: ".agent-vigil/session.jsonl",
    transcriptSha256: `sha256:${"1".repeat(64)}`,
    transcriptFormat: "codex",
    repo: "/private/repository",
    base,
    head: "b".repeat(40),
    results,
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
    repository: { tree: "c".repeat(40) },
    reproduction: "vigil private command",
  });
}

test("proof comment is deterministic, single-marker, and aggregate-only", () => {
  const receipt = report([
    check("differential-test", "verified", "differential_test"),
    check("differential-base-fail", "contradicted", "differential_test", "SECRET_DETAIL"),
    check("integrity-scan", "contradicted", "integrity", "HOSTILE_DETAIL"),
    check("authority-network", "contradicted", "authority_scope"),
  ]);
  const first = renderProofComment(receipt);
  const second = renderProofComment(receipt);

  assert.equal(first, second);
  assert.equal(first.split(PROOF_COMMENT_MARKER).length - 1, 1);
  assert.match(first, /Candidate-only regression checks:\*\* 1 verified/);
  assert.match(first, /also passed on base:\*\* 1/);
  assert.match(first, /Integrity-control contradictions:\*\* 1/);
  assert.match(first, /Unapproved authority contradictions:\*\* 1/);
  assert.doesNotMatch(first, /SECRET_DETAIL|HOSTILE_DETAIL|private\/repository|vigil private command/);
  assert.doesNotMatch(first, /\b(?:lie|cheat|fake)\b/i);
});

test("proof comment neutralizes unsafe identity text and accepts only HTTPS verification URLs", () => {
  const receipt = report([check("tests-pass", "verified", "tests_pass")], "abc`\u202e\u001b[2J");
  const output = renderProofComment(receipt, { verifyUrl: "https://verify.example.test/r/abc" });

  assert.ok(output.includes("``abc`\\u{202E}\\u{001B}[2J``"));
  assert.equal(
    output.split("\n").find((line) => line.startsWith("[Verify this receipt]")),
    "[Verify this receipt](https://verify.example.test/r/abc)",
  );
  assert.doesNotMatch(output.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\u2028\u2029]/u);
  assert.throws(() => renderProofComment(receipt, { verifyUrl: "http://verify.example.test" }), /absolute HTTPS URL/);
  assert.throws(() => renderProofComment(receipt, { verifyUrl: "https://user:secret@example.test" }), /without credentials/);
});

test("proof comment does not turn a passing receipt into a correctness claim", () => {
  const output = renderProofComment(report([check("tests-pass", "verified", "tests_pass")]));
  assert.match(output, /does not prove that the code is bug-free/);
  assert.match(output, /Agent Vigil: PASS/);
  assert.match(output, /Signature:\*\* absent; content hash only/);
});

test("proof comment refuses altered receipts and invalid signatures", () => {
  const altered = report([check("tests-pass", "verified", "tests_pass")]);
  altered.head = "d".repeat(40);
  assert.throws(() => renderProofComment(altered), /does not match receiptHash/);

  const signed = report([check("tests-pass", "verified", "tests_pass")]);
  signed.signature = {
    algorithm: "Ed25519",
    keyId: `sha256:${"3".repeat(64)}`,
    publicKey: Buffer.from("not a public key").toString("base64"),
    value: Buffer.from("not a signature").toString("base64"),
  };
  assert.throws(() => renderProofComment(signed));
});

test("proof-comment CLI validates receipt integrity before writing private output", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-proof-comment-"));
  const receiptPath = join(root, "receipt.json");
  const outputPath = join(root, "comment.md");
  const receipt = report([check("tests-pass", "verified", "tests_pass")]);
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);

  assert.equal(run(["proof-comment", receiptPath, "--output", outputPath]), 0);
  assert.match(readFileSync(outputPath, "utf8"), /Agent Vigil: PASS/);

  receipt.summary.verified += 1;
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const original = console.error;
  const errors: string[] = [];
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
  try {
    assert.equal(run(["proof-comment", receiptPath, "--output", outputPath]), 2);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /summary\.verified does not match results and policy/);
});

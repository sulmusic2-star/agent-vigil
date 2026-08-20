import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPathsExist, parseTestSummary } from "../src/detectors/reality.ts";
import { extractClaims, toolCallFingerprint, type SessionToolCall } from "../src/transcript.ts";

let seed = 0x51a7e;
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function noise(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;[]{}()_-/#";
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

test("5000 mutated runner outputs never produce invalid numeric summaries", () => {
  const kernels = [
    "# tests 3\n# pass 3\n# fail 0",
    "3 passed, 2 skipped in 0.1s",
    "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0",
    "Passed! - Failed: 0, Passed: 3, Skipped: 0, Total: 3",
    "3 runs, 6 assertions, 0 failures, 0 errors, 0 skips",
  ];
  for (let index = 0; index < 5000; index++) {
    const output = `${noise(index % 23)}\n${kernels[index % kernels.length]}\n${noise(index % 31)}`;
    const summary = parseTestSummary(output);
    for (const value of Object.values(summary)) assert.ok(Number.isInteger(value) && value >= 0);
  }
});

test("2000 ordinary dotted terms do not become implicit path claims", () => {
  for (let index = 0; index < 2000; index++) {
    const prose = `Runtime Node.js contacted example${index}.com with version v${index % 9}.${index % 7}. Nothing else changed.`;
    assert.equal(extractClaims(prose).filter((claim) => claim.kind === "path_exists").length, 0);
  }
});

test("1000 traversal variants cannot satisfy path-existence claims", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-fuzz-path-"));
  writeFileSync(join(repo, "inside.txt"), "inside\n");
  for (let index = 0; index < 1000; index++) {
    const subject = `${"nested/".repeat(index % 4)}${"../".repeat((index % 5) + 1)}outside-${index}.txt`;
    const claim = { kind: "path_exists" as const, quote: subject, subject };
    assert.equal(checkPathsExist([claim], repo)[0].verdict, "contradicted");
  }
});

test("1000 JSON key-order permutations retain one tool fingerprint", () => {
  const expected: SessionToolCall = { id: "0", name: "Bash", input: '{"cmd":"npm test","cwd":".","timeout":30}', sequence: 0 };
  const fingerprint = toolCallFingerprint(expected);
  const keys = ["cmd", "cwd", "timeout"] as const;
  const value = { cmd: "npm test", cwd: ".", timeout: 30 };
  for (let index = 0; index < 1000; index++) {
    const ordered = [...keys].sort(() => random() - 0.5);
    const object = Object.fromEntries(ordered.map((key) => [key, value[key]]));
    assert.equal(toolCallFingerprint({ ...expected, id: String(index), input: JSON.stringify(object) }), fingerprint);
  }
});

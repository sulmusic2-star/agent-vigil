import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r\n", "\n");
const expectedSequence = [
  "      - name: Install without lifecycle scripts",
  "        run: npm ci --ignore-scripts",
  "      - name: Check release contracts before expensive work",
  "        run: node --import tsx --test --test-concurrency=1 test/package-surface.test.ts",
  "      - name: Type-check",
  "        run: npm run typecheck",
  "      - name: Build the candidate bundle",
  "        run: npm run build",
  "      - name: Run the candidate test suite",
  "        run: npm test",
].join("\n");

for (const job of ["candidate-ci", "portability"]) {
  test(`${job} checks release contracts first without skipping the full checks`, () => {
    const block = workflow.match(new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"))?.[0];
    assert.ok(block, `Missing ${job} job`);
    assert.ok(block.includes(expectedSequence), "Keep the unconditional preflight between installation and the full checks");
    assert.equal(block.split("- name: Check release contracts before expensive work").length - 1, 1);
  });
}

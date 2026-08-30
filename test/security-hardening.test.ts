import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markdownCodeSpan, markdownTableCell } from "../src/markdown.ts";
import { escapeRegExpLiteral } from "../src/regex.ts";
import { readRegularFileSnapshot } from "../src/safe-fs.ts";

test("Markdown code spans contain hostile backticks, controls, and line breaks", () => {
  const value = " path\\name ` `` <script>\r\nnext ";
  const rendered = markdownCodeSpan(value);
  assert.ok(rendered.startsWith("```"));
  assert.equal(rendered.includes("\r"), false);
  assert.equal(rendered.includes("\n"), false);
  assert.ok(rendered.includes("path\\name ` `` <script> next"));
});

test("Markdown table cells escape backslashes before pipes", () => {
  assert.equal(markdownTableCell("a\\|b\r\nc"), "a\\\\\\|b c");
});

test("regular-file snapshots reject symbolic links and oversized input", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-safe-fs-"));
  try {
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    writeFileSync(target, "{\"ok\":true}", { mode: 0o600 });
    symlinkSync(target, link);
    assert.throws(() => readRegularFileSnapshot(link, 1024, "fixture"), /symbolic link|ELOOP/);
    assert.throws(() => readRegularFileSnapshot(target, 2, "fixture"), /maximum is 2/);
    assert.equal(readRegularFileSnapshot(target, 1024, "fixture").bytes.toString("utf8"), "{\"ok\":true}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regular-expression literals cannot inject operators or groups", () => {
  const hostile = "name$)(?<injected>.*";
  const expression = new RegExp(`^${escapeRegExpLiteral(hostile)}$`);
  assert.equal(expression.test(hostile), true);
  assert.equal(expression.test("nameXanything"), false);
});

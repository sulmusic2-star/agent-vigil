import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markdownCodeSpan, markdownTableCell } from "../src/markdown.ts";
import { escapeRegExpLiteral } from "../src/regex.ts";
import { readRegularFileSnapshot } from "../src/safe-fs.ts";
import { trustedGit } from "../src/trusted-git.ts";

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

test("trusted Git rejects a byte-identical atomic binary replacement", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-trusted-git-"));
  const previous = process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
  try {
    const systemGit = realpathSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
    const trusted = join(root, "git");
    const replacement = join(root, "git.next");
    copyFileSync(systemGit, trusted);
    chmodSync(trusted, 0o755);
    process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = trusted;
    assert.match(trustedGit(process.cwd(), ["rev-parse", "--show-toplevel"]), /agent-vigil/);

    copyFileSync(systemGit, replacement);
    chmodSync(replacement, 0o755);
    renameSync(replacement, trusted);
    assert.throws(
      () => trustedGit(process.cwd(), ["rev-parse", "--show-toplevel"]),
      /trusted Git binary changed during verification/,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
    else process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("regular-expression literals cannot inject operators or groups", () => {
  const hostile = "name$)(?<injected>.*";
  const expression = new RegExp(`^${escapeRegExpLiteral(hostile)}$`);
  assert.equal(expression.test(hostile), true);
  assert.equal(expression.test("nameXanything"), false);
});

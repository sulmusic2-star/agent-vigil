import test from "node:test";
import assert from "node:assert/strict";
import { adoptionRegistrationUrl, formatLocalCommand, githubRepositorySlug, localCliCommand, workflowBadge } from "../src/adoption.ts";

test("GitHub repository identity accepts common exact remotes", () => {
  for (const remote of [
    "https://github.com/example/project.git",
    "git@github.com:example/project.git",
    "ssh://git@github.com/example/project.git",
    "git://github.com/example/project.git",
  ]) assert.equal(githubRepositorySlug(remote), "example/project");
});

test("GitHub repository identity rejects credentials, extra paths, controls, and other hosts", () => {
  for (const remote of [
    "https://token@github.com/example/project.git",
    "ssh://token@github.com/example/project.git",
    "git://token@github.com/example/project.git",
    "ssh://git@github.com:2222/example/project.git",
    "https://github.com/example/project.git?token=secret",
    "https://github.com/example/project/extra.git",
    "https://evil.example/example/project.git",
    "git@github.com:example/project/extra.git",
    "git@github.com:example/project.git\nmarkdown",
    "git@github.com:../project.git",
  ]) assert.equal(githubRepositorySlug(remote), undefined);
});

test("badge and registration links contain only validated repository identity", () => {
  assert.equal(
    workflowBadge("example/project"),
    "[![Agent Vigil workflow](https://github.com/example/project/actions/workflows/agent-vigil.yml/badge.svg)](https://github.com/example/project/actions/workflows/agent-vigil.yml)",
  );
  assert.match(adoptionRegistrationUrl("example/project"), /title=%5Badoption%5D%20example%2Fproject$/);
  assert.throws(() => workflowBadge("example/project/extra"));
});

test("local handoffs never acquire another package", () => {
  for (const command of ["doctor", "protect"] as const) {
    const value = localCliCommand(command, new URL("../dist/cli.js", import.meta.url).href);
    assert.ok(value.includes(command));
    assert.ok(value.includes("cli.js"));
    assert.doesNotMatch(value, /npx|https:|--import|agent-vigil@/);
  }
});

test("local commands quote POSIX and PowerShell arguments literally", () => {
  assert.equal(formatLocalCommand(["/node", "/path with ' quote/$() `tick`;&/cli.js", "doctor", "--repo", ""], "linux"),
    "/node '/path with '\\'' quote/$() `tick`;&/cli.js' doctor --repo ''");
  assert.equal(formatLocalCommand(["C:\\Program Files\\node.exe", "D:\\user's $() `tick`;&\\cli.js", "doctor", "--repo", ""], "win32"),
    "& 'C:\\Program Files\\node.exe' 'D:\\user''s $() `tick`;&\\cli.js' 'doctor' '--repo' ''");
  for (const platform of ["linux", "win32"] as const) {
    for (const control of ["\n", "\r", "\0", "\u001b", "\u0085"]) {
      assert.throws(() => formatLocalCommand(["node", "path" + control], platform), /control characters/);
    }
    assert.throws(() => formatLocalCommand([], platform), /control characters/);
  }
});

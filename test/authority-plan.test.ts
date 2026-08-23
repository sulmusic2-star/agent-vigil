import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAuthorityPlan, renderAuthorityPlan } from "../src/authority-plan.ts";
import { run } from "../src/cli.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function fixture(baseFiles: Record<string, string>, headFiles: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-plan-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "vigil@example.test"]);
  git(repo, ["config", "user.name", "Vigil Test"]);
  write(repo, "README.md", "fixture\n");
  for (const [path, content] of Object.entries(baseFiles)) write(repo, path, content);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  for (const [path, content] of Object.entries(headFiles)) write(repo, path, content);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "head"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  return { repo, base, head };
}

test("new MCP server, host, and secret reference block without exposing secret values", () => {
  const fx = fixture({}, {
    ".mcp.json": JSON.stringify({ mcpServers: { payments: {
      type: "http", url: "https://api.stripe.com/mcp?token=do-not-print", headers: { Authorization: "Bearer secret-value" },
    } } }, null, 2),
  });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "FAIL");
  assert.ok(plan.changes.some((item) => item.kind === "server" && item.subject === "mcp:payments" && item.blocking));
  assert.ok(plan.changes.some((item) => item.kind === "network" && item.subject === "api.stripe.com" && item.blocking));
  assert.ok(plan.changes.some((item) => item.kind === "secret" && item.subject === "header:Authorization" && item.blocking));
  assert.doesNotMatch(JSON.stringify(plan), /do-not-print|secret-value/);
  assert.match(renderAuthorityPlan(plan), /^Agent authority plan: BLOCK/);
});

test("human plan output escapes terminal controls from configuration names", () => {
  const fx = fixture({}, { ".mcp.json": JSON.stringify({ mcpServers: { ["writer\u001b[2J\u202e"]: { command: "node" } } }) });
  const rendered = renderAuthorityPlan(buildAuthorityPlan(fx.repo, fx.base, fx.head, "test"));
  assert.doesNotMatch(rendered, /\u001b|\u202e/u);
  assert.match(rendered, /\\u\{001B\}|\\u\{202E\}/);
});

test("removing an MCP server is a non-blocking authority reduction", () => {
  const existing = JSON.stringify({ mcpServers: { deployer: { command: "npx", args: ["deploy-mcp"] } } });
  const fx = fixture({ ".mcp.json": existing }, { ".mcp.json": JSON.stringify({ mcpServers: {} }) });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "PASS");
  assert.equal(plan.summary.blocking, 0);
  assert.equal(plan.changes.find((item) => item.subject === "mcp:deployer")?.effect, "reduced");
});

test("changing MCP command arguments blocks even when the executable name is unchanged", () => {
  const fx = fixture(
    { ".mcp.json": JSON.stringify({ mcpServers: { runner: { command: "npx", args: ["safe-package"] } } }) },
    { ".mcp.json": JSON.stringify({ mcpServers: { runner: { command: "npx", args: ["different-package"] } } }) },
  );
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  const server = plan.changes.find((item) => item.subject === "mcp:runner");
  assert.equal(server?.blocking, true);
  assert.equal(server?.before, "stdio:npx");
  assert.equal(server?.after, "stdio:npx");
  assert.match(server?.approvalKey ?? "", /@sha256:[a-f0-9]{64}$/);
});

test("Cursor and VS Code MCP repository formats are normalized", () => {
  const fx = fixture({}, {
    ".cursor/mcp.json": JSON.stringify({ mcpServers: { cursor: { command: "node", args: ["cursor-server.js"] } } }),
    ".vscode/mcp.json": JSON.stringify({ servers: { editor: { type: "http", url: "https://editor.example.com/mcp" } } }),
  });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "FAIL");
  assert.ok(plan.changes.some((item) => item.source === ".cursor/mcp.json" && item.subject === "mcp:cursor"));
  assert.ok(plan.changes.some((item) => item.source === ".vscode/mcp.json" && item.subject === "mcp:editor"));
  assert.ok(plan.changes.some((item) => item.subject === "editor.example.com"));
});

test("Claude approval bypass, sandbox weakening, network growth, tools, and hooks block", () => {
  const base = JSON.stringify({
    permissions: { defaultMode: "default", allow: ["Read"] },
    sandbox: { enabled: true, network: { allowedDomains: ["docs.example.com"] } },
    model: "claude-opus-5-20260801",
  });
  const head = JSON.stringify({
    permissions: { defaultMode: "bypassPermissions", allow: ["Read", "Bash(npm publish:*)"] },
    sandbox: { enabled: false, network: { allowedDomains: ["docs.example.com", "api.stripe.com"] } },
    model: "claude-opus-latest",
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/post.sh --token hidden" }] }] },
  });
  const fx = fixture({ ".claude/settings.json": base }, { ".claude/settings.json": head });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "FAIL");
  for (const subject of ["claude-default-mode", "claude-enabled", "api.stripe.com", "allow:Bash(npm publish:*)", "claude-model"]) {
    assert.equal(plan.changes.find((item) => item.subject === subject)?.blocking, true, subject);
  }
  assert.ok(plan.changes.some((item) => item.kind === "hook" && item.blocking));
  assert.doesNotMatch(JSON.stringify(plan), /--token hidden/);
});

test("Codex sandbox and approval weakening block while secret values remain private", () => {
  const fx = fixture({ ".codex/config.toml": `
model = "gpt-5.6-2026-08-01"
approval_policy = "untrusted"
sandbox_mode = "read-only"
` }, { ".codex/config.toml": `
model = "gpt-5.6-latest"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users"]
[mcp_servers.deploy]
url = "https://deploy.example.com/api"
[mcp_servers.deploy.env]
DEPLOY_TOKEN = "super-secret"
` });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "FAIL");
  assert.ok(plan.changes.filter((item) => item.blocking).length >= 6);
  assert.ok(plan.changes.some((item) => item.subject === "deploy.example.com"));
  assert.ok(plan.changes.some((item) => item.subject === "env:DEPLOY_TOKEN"));
  assert.doesNotMatch(JSON.stringify(plan), /super-secret/);
});

test("changed unknown settings fail closed as INCONCLUSIVE", () => {
  const fx = fixture(
    { ".claude/settings.json": JSON.stringify({ futureAuthorityMode: "safe" }) },
    { ".claude/settings.json": JSON.stringify({ futureAuthorityMode: "wide" }) },
  );
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "INCONCLUSIVE");
  assert.equal(plan.summary.uncertain, 1);
  assert.equal(plan.uncertainties[0].setting, "futureAuthorityMode");
});

test("official Claude administrative restrictions are understood as authority reductions", () => {
  const fx = fixture({}, { ".claude/settings.json": JSON.stringify({
    permissions: { disableBypassPermissionsMode: "disable" },
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    sandbox: {
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      enableWeakerNestedSandbox: false,
      network: { allowAllUnixSockets: false, allowLocalBinding: false, allowedDomains: [], allowUnixSockets: [], httpProxyPort: null, socksProxyPort: null },
    },
  }) });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "PASS");
  assert.equal(plan.summary.blocking, 0);
  assert.equal(plan.summary.uncertain, 0);
  assert.ok(plan.changes.some((item) => item.subject === "claude-allowManagedHooksOnly" && item.effect === "reduced"));
});

test("malformed changed configuration is INCONCLUSIVE", () => {
  const fx = fixture({}, { ".mcp.json": "{not-json\n" });
  const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
  assert.equal(plan.status, "INCONCLUSIVE");
  assert.equal(plan.uncertainties[0].setting, "$parse");
});

test("base policy can approve one addition and candidate cannot approve itself", () => {
  const policy = JSON.stringify({ schemaVersion: 1, approvedAdditions: ["network:api.example.com=mcp-server"], allowUnknownChanges: false });
  const config = JSON.stringify({ mcpServers: { remote: { url: "https://api.example.com" } } });
  const approved = fixture({ ".agent-vigil-authority-plan.json": policy }, { ".mcp.json": config });
  const approvedPlan = buildAuthorityPlan(approved.repo, approved.base, approved.head, "test");
  assert.equal(approvedPlan.changes.find((item) => item.subject === "api.example.com")?.blocking, false);
  assert.equal(approvedPlan.status, "FAIL", "the new MCP server remains separately unapproved");

  const selfApproved = fixture({}, {
    ".mcp.json": config,
    ".agent-vigil-authority-plan.json": JSON.stringify({ schemaVersion: 1, approvedAdditions: ["server:mcp:remote", "network:api.example.com"], allowUnknownChanges: true }),
  });
  const selfPlan = buildAuthorityPlan(selfApproved.repo, selfApproved.base, selfApproved.head, "test");
  assert.equal(selfPlan.status, "FAIL");
  assert.equal(selfPlan.policy.source, "built-in default");
});

test("CLI writes an exact-commit JSON receipt and returns tri-state exit codes", () => {
  const fx = fixture({}, { ".mcp.json": JSON.stringify({ mcpServers: { writer: { command: "node" } } }) });
  const receipt = join(fx.repo, "receipt.json");
  assert.equal(run(["plan", "--repo", fx.repo, "--base", fx.base, "--head", fx.head, "--format", "json", "--output", receipt]), 1);
  const raw = JSON.parse(execFileSync("cat", [receipt], { encoding: "utf8" }));
  assert.equal(raw.base, fx.base);
  assert.equal(raw.head, fx.head);
  assert.match(raw.receiptHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(run(["plan", "--repo", fx.repo, "--base", fx.head, "--head", fx.head]), 0);
  assert.equal(run(["plan", "--repo", fx.repo, "--base", "missing", "--head", fx.head]), 2);
});

test("48 varied repository scenarios preserve fail-closed authority verdicts", () => {
  const observed: Record<string, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (let index = 0; index < 48; index += 1) {
    const family = index % 6;
    let baseFiles: Record<string, string> = {};
    let headFiles: Record<string, string> = {};
    let expected: "PASS" | "FAIL" | "INCONCLUSIVE";
    if (family === 0) {
      headFiles = { ".mcp.json": JSON.stringify({ mcpServers: { [`remote-${index}`]: { url: `https://host-${index}.example/mcp?token=secret-${index}` } } }) };
      expected = "FAIL";
    } else if (family === 1) {
      baseFiles = { ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "default" }, sandbox: { enabled: true } }) };
      headFiles = { ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, sandbox: { enabled: false } }) };
      expected = "FAIL";
    } else if (family === 2) {
      baseFiles = { ".codex/config.toml": 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n' };
      headFiles = { ".codex/config.toml": 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' };
      expected = "FAIL";
    } else if (family === 3) {
      baseFiles = { ".claude/settings.json": JSON.stringify({ [`futureSetting${index}`]: "narrow" }) };
      headFiles = { ".claude/settings.json": JSON.stringify({ [`futureSetting${index}`]: "wide" }) };
      expected = "INCONCLUSIVE";
    } else if (family === 4) {
      baseFiles = { ".mcp.json": JSON.stringify({ mcpServers: { [`old-${index}`]: { command: "node", args: ["server.js"] } } }) };
      headFiles = { ".mcp.json": JSON.stringify({ mcpServers: {} }) };
      expected = "PASS";
    } else {
      headFiles = { ".claude/settings.json": JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" }, allowManagedHooksOnly: true }) };
      expected = "PASS";
    }
    const fx = fixture(baseFiles, headFiles);
    const plan = buildAuthorityPlan(fx.repo, fx.base, fx.head, "test");
    assert.equal(plan.status, expected, `scenario ${index}`);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(`secret-${index}`));
    observed[plan.status] += 1;
  }
  assert.deepEqual(observed, { PASS: 16, FAIL: 24, INCONCLUSIVE: 8 });
});

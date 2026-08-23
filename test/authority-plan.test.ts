import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildAuthorityPlan, discoverAuthorityProfile, renderAuthorityPlanMarkdown, renderAuthorityPlanText } from "../src/authority-plan.ts";
import { run } from "../src/cli.ts";

type Fixture = { repo: string; base: string };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "vigil-authority-plan-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  write(repo, "README.md", "base\n");
  return { repo, base: commit(repo, "base") };
}

function write(repo: string, path: string, value: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), value);
}

function json(repo: string, path: string, value: unknown): void {
  write(repo, path, `${JSON.stringify(value, null, 2)}\n`);
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function commitFile(repo: string, path: string, value: string, message = "change"): string {
  write(repo, path, value);
  return commit(repo, message);
}

test("unchanged and unrelated revisions pass with exact profile digests", () => {
  const value = fixture();
  const same = buildAuthorityPlan(value.repo, value.base, value.base);
  assert.equal(same.status, "PASS");
  assert.equal(same.summary.changes, 0);
  assert.match(same.baseProfileSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(same.baseProfileSha256, same.headProfileSha256);

  const head = commitFile(value.repo, "README.md", "unrelated\n");
  const unrelated = buildAuthorityPlan(value.repo, value.base, head);
  assert.equal(unrelated.status, "PASS");
  assert.equal(unrelated.summary.sources, 0);
});

test("a new MCP server blocks and omits secrets and control characters", () => {
  const value = fixture();
  const secret = "ghp_1234567890abcdefghijklmnopqrstuv";
  json(value.repo, ".mcp.json", {
    mcpServers: {
      payments: {
        command: "/usr/local/bin/npx",
        args: ["-y", "server", `--token=${secret}`],
        env: { API_TOKEN: secret },
      },
    },
  });
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default", allow: [`Bash(curl -H 'Authorization: Bearer ${secret}'\nFAKE: PASS)`] },
  });
  const head = commit(value.repo, "add authority");
  const plan = buildAuthorityPlan(value.repo, value.base, head);
  const serialized = JSON.stringify(plan);
  const rendered = renderAuthorityPlanText(plan);

  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP002"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP008"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP009"));
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /FAKE: PASS/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});

test("malformed supported configuration holds without echoing its contents", () => {
  const value = fixture();
  const secret = "sk_live_should_not_escape";
  const head = commitFile(value.repo, ".codex/config.toml", `sandbox_mode = \"${secret}\n`, "malformed config");
  const plan = buildAuthorityPlan(value.repo, value.base, head);
  assert.equal(plan.status, "HOLD");
  assert.equal(plan.gaps.length, 1);
  assert.match(plan.gaps[0].reason, /TOML parse failed/);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));
});

test("deep configuration holds before extraction and executable labels omit environment assignments", () => {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.nested = next;
    cursor = next;
  }
  const value = fixture();
  json(value.repo, ".claude/settings.json", deep);
  const deepHead = commit(value.repo, "deep config");
  const held = buildAuthorityPlan(value.repo, value.base, deepHead);
  assert.equal(held.status, "HOLD");
  assert.match(held.gaps[0].reason, /parse failed/);

  json(value.repo, ".mcp.json", { mcpServers: { assigned: { command: "FOO=bar node server.js" } } });
  const commandHead = commit(value.repo, "assignment command");
  const plan = buildAuthorityPlan(value.repo, deepHead, commandHead);
  assert.equal(plan.status, "BLOCK");
  assert.match(JSON.stringify(plan), /environment-assignment/);
  assert.doesNotMatch(JSON.stringify(plan), /FOO=bar/);
});

test("Codex sandbox, network, and writable-root expansion blocks", () => {
  const value = fixture();
  write(value.repo, ".codex/config.toml", [
    'sandbox_mode = "read-only"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "user"',
    "[sandbox_workspace_write]",
    "network_access = false",
    "writable_roots = []",
    "",
  ].join("\n"));
  const base = commit(value.repo, "codex base");
  const head = commitFile(value.repo, ".codex/config.toml", [
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "user"',
    "[sandbox_workspace_write]",
    "network_access = true",
    'writable_roots = ["/tmp/outside"]',
    "",
  ].join("\n"), "expand codex authority");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP005" && delta.direction === "EXPANSION"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP006" && delta.direction === "EXPANSION"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP007" && delta.direction === "EXPANSION"));
});

test("Claude permission contractions pass while removed denies and bypass expansion block", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", { permissions: { defaultMode: "default", deny: [] } });
  const base = commit(value.repo, "claude base");

  json(value.repo, ".claude/settings.json", { permissions: { defaultMode: "default", deny: ["Bash(rm:*)"] } });
  const denied = commit(value.repo, "add deny");
  const contraction = buildAuthorityPlan(value.repo, base, denied);
  assert.equal(contraction.status, "PASS");
  assert.ok(contraction.deltas.some((delta) => delta.ruleId === "AVP000" && delta.direction === "CONTRACTION"));

  json(value.repo, ".claude/settings.json", { permissions: { defaultMode: "bypassPermissions", deny: [] } });
  const bypass = commit(value.repo, "remove deny and bypass");
  const expansion = buildAuthorityPlan(value.repo, denied, bypass);
  assert.equal(expansion.status, "BLOCK");
  assert.ok(expansion.deltas.some((delta) => delta.ruleId === "AVP010"));
  assert.ok(expansion.deltas.some((delta) => delta.ruleId === "AVP004"));
});

test("Claude plugin enablement blocks and hook matcher changes cannot pass silently", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "node guard.js" }] }] },
  });
  const base = commit(value.repo, "hook base");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    enabledPlugins: { "deployer@example": true },
    hooks: { PreToolUse: [{ matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command: "node guard.js" }] }] },
  });
  const head = commit(value.repo, "expand plugin and hook matcher");
  const plan = buildAuthorityPlan(value.repo, base, head);
  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP015" && delta.disposition === "BLOCK"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP014" && delta.disposition === "HOLD" && delta.after?.action === "hook.execute"));
});

test("removing an enabled MCP server contracts its child deny-list rules", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", {
    mcpServers: {
      github: {
        url: "https://example.test/mcp",
        disabled_tools: ["delete_file", "push_files"],
        env: { GITHUB_TOKEN: "environment-reference" },
      },
    },
  });
  const base = commit(value.repo, "mcp base");
  json(value.repo, ".mcp.json", { mcpServers: {} });
  const head = commit(value.repo, "remove mcp server");
  const plan = buildAuthorityPlan(value.repo, base, head);
  assert.equal(plan.status, "PASS");
  assert.equal(plan.summary.blocking, 0);
  assert.ok(plan.deltas.every((delta) => delta.direction === "CONTRACTION"));
});

test("UTF-8 BOM JSON is parsed before authority extraction", () => {
  const value = fixture();
  const head = commitFile(value.repo, ".cursor/mcp.json", `\ufeff${JSON.stringify({ mcpServers: { supabase: { url: "https://mcp.supabase.com/mcp" } } })}\n`);
  const plan = buildAuthorityPlan(value.repo, value.base, head);
  assert.equal(plan.status, "BLOCK");
  assert.equal(plan.gaps.length, 0);
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP002"));
});

test("MCP approval modes use a partial order instead of a fake scalar score", () => {
  const value = fixture();
  const config = (mode: string) => ({ mcpServers: { docs: { command: "node", args: ["server.js"], default_tools_approval_mode: mode } } });
  json(value.repo, ".mcp.json", config("prompt"));
  const prompt = commit(value.repo, "prompt");
  json(value.repo, ".mcp.json", config("auto"));
  const auto = commit(value.repo, "auto");
  json(value.repo, ".mcp.json", config("writes"));
  const writes = commit(value.repo, "writes");
  json(value.repo, ".mcp.json", config("approve"));
  const approve = commit(value.repo, "approve");

  assert.equal(buildAuthorityPlan(value.repo, prompt, auto).status, "BLOCK");
  const incomparable = buildAuthorityPlan(value.repo, auto, writes);
  assert.equal(incomparable.status, "HOLD");
  assert.ok(incomparable.deltas.some((delta) => delta.direction === "INCOMPARABLE"));
  assert.equal(buildAuthorityPlan(value.repo, approve, prompt).status, "PASS");
});

test("MCP discovery covers transport, headers, scopes, tool selection, and per-tool approval", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { servers: { service: {
    disabled: true,
    serverUrl: "https://example.test/old/path?secret=omitted",
    disabledTools: ["delete"],
    defaultToolsApprovalMode: "prompt",
    tools: { read: { approvalMode: "prompt" } },
  } } });
  const base = commit(value.repo, "restricted mcp");
  json(value.repo, ".mcp.json", { servers: { service: {
    enabled: true,
    url: "https://api.example.test/mcp?credential=omitted",
    http_headers: { AUTHORIZATION: "environment-reference" },
    headers: { "X-TENANT": "environment-reference" },
    bearer_token_env_var: "SERVICE_TOKEN",
    scopes: ["repository:write"],
    enabled_tools: ["write"],
    default_tools_approval_mode: "approve",
    tools: { read: { approval_mode: "auto" } },
  } } });
  const head = commit(value.repo, "expand mcp");
  const plan = buildAuthorityPlan(value.repo, base, head);
  const serialized = JSON.stringify(plan);
  assert.equal(plan.status, "BLOCK");
  for (const ruleId of ["AVP002", "AVP004", "AVP008", "AVP013"]) {
    assert.ok(plan.deltas.some((delta) => delta.ruleId === ruleId), `missing ${ruleId}`);
  }
  assert.doesNotMatch(serialized, /environment-reference|credential=omitted|secret=omitted/);
  assert.match(renderAuthorityPlanMarkdown(plan), /\| BLOCK \|/);
});

test("Claude discovery covers sandbox, MCP approvals, environment, plugin, hook, and model changes", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "plan", ask: ["WebFetch(domain:example.test)"], disableBypassPermissionsMode: "disable" },
    sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains: [] } },
    enableAllProjectMcpServers: false,
    disabledMcpjsonServers: ["deploy"],
    enabledPlugins: { "deploy@example": false },
    hooks: { PostToolUse: [{ hooks: [{ type: "prompt" }] }] },
    model: "claude-pinned-1",
  });
  const base = commit(value.repo, "claude restricted");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: false },
    additionalDirectories: ["/tmp/external"],
    sandbox: { enabled: false, failIfUnavailable: false, network: { allowedDomains: ["api.example.test"] } },
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: ["deploy"],
    enabledPlugins: { "deploy@example": true },
    env: { DEPLOY_TOKEN: "environment-reference" },
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/node hook.js" }] }] },
    model: "claude-latest",
  });
  const head = commit(value.repo, "claude expanded");
  const plan = buildAuthorityPlan(value.repo, base, head);
  assert.equal(plan.status, "BLOCK");
  for (const ruleId of ["AVP003", "AVP004", "AVP005", "AVP007", "AVP008", "AVP012", "AVP015"]) {
    assert.ok(plan.deltas.some((delta) => delta.ruleId === ruleId), `missing ${ruleId}`);
  }
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP014" && delta.after?.action === "hook.execute"));
});

test("Codex discovery covers reviewer, environment inheritance, secret exclusions, and explicit values", () => {
  const value = fixture();
  write(value.repo, ".codex/config.toml", [
    'sandbox_mode = "read-only"',
    'approval_policy = "on-request"',
    'approvals_reviewer = "user"',
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "set = {}",
    "",
  ].join("\n"));
  const base = commit(value.repo, "codex restricted");
  write(value.repo, ".codex/config.toml", [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    'approvals_reviewer = "auto_review"',
    'model = "codex-default"',
    "[shell_environment_policy]",
    'inherit = "all"',
    "ignore_default_excludes = true",
    'set = { DEPLOY_TOKEN = "environment-reference" }',
    "",
  ].join("\n"));
  const head = commit(value.repo, "codex expanded");
  const plan = buildAuthorityPlan(value.repo, base, head);
  assert.equal(plan.status, "BLOCK");
  for (const ruleId of ["AVP004", "AVP005", "AVP008", "AVP012"]) {
    assert.ok(plan.deltas.some((delta) => delta.ruleId === ruleId), `missing ${ruleId}`);
  }
  assert.doesNotMatch(JSON.stringify(plan), /environment-reference/);
});

test("current Claude extra-root location and evolving Codex authority sections cannot pass silently", () => {
  const claude = fixture();
  json(claude.repo, ".claude/settings.json", { permissions: { defaultMode: "default", additionalDirectories: [] } });
  const claudeBase = commit(claude.repo, "claude restricted");
  json(claude.repo, ".claude/settings.json", { permissions: { defaultMode: "default", additionalDirectories: ["/tmp/external"] } });
  const claudeHead = commit(claude.repo, "claude extra root");
  const claudePlan = buildAuthorityPlan(claude.repo, claudeBase, claudeHead);
  assert.equal(claudePlan.status, "BLOCK");
  assert.ok(claudePlan.deltas.some((delta) => delta.ruleId === "AVP007" && delta.after?.locator === "permissions.additionalDirectories"));

  const codex = fixture();
  write(codex.repo, ".codex/config.toml", 'sandbox_mode = "read-only"\n');
  const codexBase = commit(codex.repo, "codex restricted");
  write(codex.repo, ".codex/config.toml", [
    'sandbox_mode = "read-only"',
    "[agents]",
    "enabled = true",
    "[tools]",
    "web_search = true",
    "",
  ].join("\n"));
  const codexHead = commit(codex.repo, "enable agents and web search");
  const codexPlan = buildAuthorityPlan(codex.repo, codexBase, codexHead);
  assert.equal(codexPlan.status, "HOLD");
  assert.equal(codexPlan.summary.holds, 2);
  assert.ok(codexPlan.deltas.every((delta) => delta.ruleId === "AVP014"));
});

test("current MCP credential and remote-execution fields are normalized or held", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { mcpServers: { service: { url: "https://example.test/mcp" } } });
  const base = commit(value.repo, "mcp base");
  json(value.repo, ".mcp.json", { mcpServers: { service: {
    url: "https://example.test/mcp",
    auth: "chatgpt",
    env_http_headers: { Authorization: "environment-reference" },
    env_vars: [{ name: "DEPLOY_TOKEN", source: "remote" }],
    experimental_environment: "remote",
    oauth_resource: "https://api.example.test/resource?secret=omitted",
    vendorAuthorityMode: "automatic",
  } } });
  const head = commit(value.repo, "expand current mcp fields");
  const plan = buildAuthorityPlan(value.repo, base, head);
  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP008"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP009"));
  assert.ok(plan.deltas.some((delta) => delta.ruleId === "AVP014" && delta.after?.action === "authority.opaque"));
  assert.doesNotMatch(JSON.stringify(plan), /environment-reference|secret=omitted|automatic/);
});

test("unsupported MCP root and server-container shapes hold instead of passing silently", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { mcpServers: {} });
  const base = commit(value.repo, "valid mcp root");
  json(value.repo, ".mcp.json", {
    mcpServers: [],
    futureAuthority: { mode: "automatic", token: "sk_live_should_not_escape" },
  });
  const head = commit(value.repo, "unsupported mcp root");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "HOLD");
  assert.equal(plan.summary.holds, 2);
  assert.ok(plan.deltas.every((delta) => delta.ruleId === "AVP014" && delta.after?.action === "authority.opaque"));
  assert.doesNotMatch(JSON.stringify(plan), /automatic|sk_live_should_not_escape/);

  json(value.repo, ".mcp.json", {
    mcpServers: {},
    servers: { shadow: { command: "node", args: ["--token=sk_live_should_not_escape"] } },
  });
  const dualRootHead = commit(value.repo, "ambiguous mcp roots");
  const dualRoot = buildAuthorityPlan(value.repo, base, dualRootHead);
  assert.equal(dualRoot.status, "HOLD");
  assert.ok(dualRoot.deltas.some((delta) => delta.ruleId === "AVP014" && delta.after?.locator === "servers"));
  assert.doesNotMatch(JSON.stringify(dualRoot), /sk_live_should_not_escape/);
});

test("Claude sandbox escape controls block while unmodeled nested controls hold", () => {
  const value = fixture();
  const restrictedSandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    enableWeakerNestedSandbox: false,
    network: {
      allowedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
  };
  json(value.repo, ".claude/settings.json", { permissions: { defaultMode: "default" }, sandbox: restrictedSandbox });
  const base = commit(value.repo, "strict claude sandbox");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    sandbox: {
      ...restrictedSandbox,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      excludedCommands: ["docker *"],
      enableWeakerNestedSandbox: true,
      network: {
        ...restrictedSandbox.network,
        allowedDomains: ["api.example.test"],
        allowUnixSockets: ["/var/run/docker.sock"],
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      },
    },
  });
  const expandedHead = commit(value.repo, "widen claude sandbox");
  const expanded = buildAuthorityPlan(value.repo, base, expandedHead);

  assert.equal(expanded.status, "BLOCK");
  const expectedRules = new Map([
    ["approval.sandbox-auto", "AVP004"],
    ["sandbox.escape", "AVP005"],
    ["sandbox.exclude", "AVP005"],
    ["sandbox.weaker-nested", "AVP005"],
    ["network.unix-socket", "AVP005"],
    ["network.unix-socket-all", "AVP005"],
    ["network.connect", "AVP006"],
    ["network.bind-local", "AVP006"],
  ]);
  for (const [action, ruleId] of expectedRules) {
    assert.ok(expanded.deltas.some((delta) =>
      delta.disposition === "BLOCK" && delta.ruleId === ruleId && delta.after?.action === action
    ), `missing ${ruleId} ${action}`);
  }

  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    sandbox: {
      ...restrictedSandbox,
      network: { ...restrictedSandbox.network, allowedDomains: [42], httpProxyPort: 8080 },
    },
  });
  const opaqueHead = commit(value.repo, "add unmodeled sandbox control");
  const opaque = buildAuthorityPlan(value.repo, base, opaqueHead);
  assert.equal(opaque.status, "HOLD");
  assert.ok(opaque.deltas.some((delta) => delta.ruleId === "AVP014" && delta.after?.locator === "sandbox.network.httpProxyPort"));
  assert.ok(opaque.deltas.some((delta) => delta.ruleId === "AVP014" && delta.after?.locator === "sandbox.network.allowedDomains"));
});

test("enabling a Claude sandbox does not treat conditional defaults as authority expansions", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", { permissions: { defaultMode: "default" } });
  const base = commit(value.repo, "claude settings without sandbox");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: ["docker *"],
      network: {
        allowedDomains: ["api.example.test"],
        allowUnixSockets: ["/var/run/docker.sock"],
      },
    },
  });
  const sandboxHead = commit(value.repo, "enable claude sandbox");
  const enabled = buildAuthorityPlan(value.repo, base, sandboxHead);

  assert.equal(enabled.status, "PASS");
  assert.ok(enabled.deltas.some((delta) => delta.after?.action === "sandbox.enforce"));
  assert.ok(enabled.deltas.some((delta) => delta.after?.action === "sandbox.escape"));
  assert.ok(enabled.deltas.some((delta) => delta.after?.action === "sandbox.exclude"));
  assert.ok(enabled.deltas.some((delta) => delta.after?.action === "network.connect"));
  assert.ok(enabled.deltas.some((delta) => delta.after?.action === "network.unix-socket"));
  assert.ok(enabled.deltas.every((delta) => delta.disposition === "ALLOW"));

  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
  });
  const restrictedHead = commit(value.repo, "disable unsandboxed retry");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
  });
  const widenedHead = commit(value.repo, "restore unsandboxed retry default");
  const widened = buildAuthorityPlan(value.repo, restrictedHead, widenedHead);

  assert.equal(widened.status, "BLOCK");
  assert.ok(widened.deltas.some((delta) =>
    delta.disposition === "BLOCK" && delta.ruleId === "AVP005" && delta.after?.action === "sandbox.escape"
  ));

  json(value.repo, ".claude/settings.json", {
    sandbox: { enabled: false, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
  });
  const disabledRestricted = commit(value.repo, "disabled sandbox with restrictive children");
  json(value.repo, ".claude/settings.json", {
    sandbox: { enabled: false, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true },
  });
  const disabledWidened = commit(value.repo, "change inactive sandbox children");
  const inactive = buildAuthorityPlan(value.repo, disabledRestricted, disabledWidened);

  assert.equal(inactive.status, "PASS");
  assert.ok(inactive.deltas.every((delta) => delta.disposition === "ALLOW"));
});

test("removing an empty Claude network container preserves default-false controls", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", { sandbox: { enabled: true, network: {} } });
  const base = commit(value.repo, "empty network container");
  json(value.repo, ".claude/settings.json", { sandbox: { enabled: true } });
  const head = commit(value.repo, "remove empty network container");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "PASS");
  assert.equal(plan.deltas.length, 0);
});

test("removing a disabled Claude sandbox does not expand synthetic defaults", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", { sandbox: { enabled: false } });
  const base = commit(value.repo, "disabled sandbox");
  json(value.repo, ".claude/settings.json", {});
  const head = commit(value.repo, "remove disabled sandbox");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "PASS");
  assert.ok(plan.deltas.every((delta) => delta.disposition === "ALLOW"));
});

test("Claude Unix-socket authority redacts secret-looking paths from every output", () => {
  const value = fixture();
  json(value.repo, ".claude/settings.json", {
    sandbox: { enabled: true, network: { allowUnixSockets: [] } },
  });
  const base = commit(value.repo, "sandbox without sockets");
  const secret = "ghp_should_not_escape";
  json(value.repo, ".claude/settings.json", {
    sandbox: { enabled: true, network: { allowUnixSockets: [`/tmp/${secret}.sock`] } },
  });
  const head = commit(value.repo, "add sensitive socket path");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) => delta.after?.resource === "redacted-unix-socket"));
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));
  assert.doesNotMatch(renderAuthorityPlanText(plan), new RegExp(secret));
  assert.doesNotMatch(renderAuthorityPlanMarkdown(plan), new RegExp(secret));
});

test("a pure Codex on-request to never transition is an approval expansion", () => {
  const value = fixture();
  write(value.repo, ".codex/config.toml", 'approval_policy = "on-request"\n');
  const base = commit(value.repo, "interactive codex approval");
  write(value.repo, ".codex/config.toml", 'approval_policy = "never"\n');
  const head = commit(value.repo, "suppress codex approval");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "BLOCK");
  assert.ok(plan.deltas.some((delta) =>
    delta.ruleId === "AVP004" && delta.direction === "EXPANSION" && delta.after?.action === "approval.policy"
  ));
});

test("discovery reads the selected Git object rather than dirty worktree files", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { mcpServers: { risky: { command: "node", args: ["server.js"] } } });
  const head = commit(value.repo, "add mcp");
  json(value.repo, ".mcp.json", { mcpServers: {} });

  const profile = discoverAuthorityProfile(value.repo, head);
  const plan = buildAuthorityPlan(value.repo, value.base, head);
  assert.ok(profile.atoms.some((item) => item.action === "mcp.connect"));
  assert.equal(plan.status, "BLOCK");
});

test("unsupported configuration paths are outside the claimed scope", () => {
  const value = fixture();
  const head = commitFile(value.repo, "other/mcp.json", JSON.stringify({ mcpServers: { risky: { command: "node" } } }));
  const plan = buildAuthorityPlan(value.repo, value.base, head);
  assert.equal(plan.status, "PASS");
  assert.equal(plan.summary.sources, 0);
  assert.match(plan.limitations[0], /supported files/);
});

test("only the trusted base policy can approve exact semantic authority deltas", () => {
  const config = { mcpServers: { deploy: { command: "node", args: ["server.js"] } } };
  const seed = fixture();
  json(seed.repo, ".mcp.json", config);
  const seedHead = commit(seed.repo, "seed authority");
  const approvalKeys = buildAuthorityPlan(seed.repo, seed.base, seedHead).deltas
    .filter((delta) => delta.disposition === "BLOCK")
    .map((delta) => delta.approvalKey);
  assert.equal(approvalKeys.length, 2);

  const approved = fixture();
  json(approved.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: approvalKeys,
    allowUnknownChanges: false,
  });
  const approvedBase = commit(approved.repo, "trusted policy");
  json(approved.repo, ".mcp.json", config);
  const approvedHead = commit(approved.repo, "approved authority");
  const approvedPlan = buildAuthorityPlan(approved.repo, approvedBase, approvedHead);
  assert.equal(approvedPlan.status, "PASS");
  assert.equal(approvedPlan.summary.approved, 2);
  assert.equal(approvedPlan.policy.source, `.agent-vigil-authority-plan.json@${approvedBase}`);

  const selfApproved = fixture();
  json(selfApproved.repo, ".mcp.json", config);
  json(selfApproved.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: approvalKeys,
    allowUnknownChanges: true,
  });
  const selfApprovedHead = commit(selfApproved.repo, "candidate self approval");
  const selfApprovedPlan = buildAuthorityPlan(selfApproved.repo, selfApproved.base, selfApprovedHead);
  assert.equal(selfApprovedPlan.status, "BLOCK");
  assert.equal(selfApprovedPlan.summary.approved, 0);
  assert.equal(selfApprovedPlan.policy.source, "built-in default");
});

test("unknown authority can be overridden only by the trusted base policy", () => {
  const approved = fixture();
  json(approved.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: [],
    allowUnknownChanges: true,
  });
  const approvedBase = commit(approved.repo, "trusted unknown policy");
  write(approved.repo, ".codex/config.toml", '[tools]\nfuture_control = true\n');
  const approvedHead = commit(approved.repo, "future authority");
  const approvedPlan = buildAuthorityPlan(approved.repo, approvedBase, approvedHead);
  assert.equal(approvedPlan.status, "PASS");
  assert.ok(approvedPlan.summary.uncertainties > 0);
  assert.equal(approvedPlan.summary.holds, 0);
  assert.ok(approvedPlan.summary.approved > 0);

  const claude = fixture();
  json(claude.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: [],
    allowUnknownChanges: true,
  });
  const claudeBase = commit(claude.repo, "trusted Claude unknown policy");
  json(claude.repo, ".claude/settings.json", { apiKeyHelper: "helper" });
  const claudeHead = commit(claude.repo, "future Claude authority");
  const claudePlan = buildAuthorityPlan(claude.repo, claudeBase, claudeHead);
  assert.equal(claudePlan.status, "PASS");
  assert.equal(claudePlan.summary.holds, 0);
  assert.ok(claudePlan.deltas.some((delta) =>
    delta.ruleId === "AVP001" && delta.after?.action === "approval.default" && delta.approvedByPolicy
  ));
  assert.ok(claudePlan.deltas.some((delta) =>
    delta.ruleId === "AVP014" && delta.after?.action === "authority.opaque" && delta.approvedByPolicy
  ));

  const selfApproved = fixture();
  write(selfApproved.repo, ".codex/config.toml", '[tools]\nfuture_control = true\n');
  json(selfApproved.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: [],
    allowUnknownChanges: true,
  });
  const selfApprovedHead = commit(selfApproved.repo, "candidate unknown override");
  const selfApprovedPlan = buildAuthorityPlan(selfApproved.repo, selfApproved.base, selfApprovedHead);
  assert.equal(selfApprovedPlan.status, "HOLD");
  assert.equal(selfApprovedPlan.policy.source, "built-in default");
});

test("allowUnknownChanges does not approve recognized incomparable hooks or models", () => {
  const value = fixture();
  json(value.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: [],
    allowUnknownChanges: true,
  });
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "node guard.js" }] }] },
  });
  const base = commit(value.repo, "trusted policy and security hook");
  json(value.repo, ".claude/settings.json", {
    permissions: { defaultMode: "default" },
    hooks: { PreToolUse: [{ matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command: "node guard.js" }] }] },
  });
  const head = commit(value.repo, "change security hook");
  const plan = buildAuthorityPlan(value.repo, base, head);

  assert.equal(plan.status, "HOLD");
  assert.equal(plan.summary.approved, 0);
  assert.ok(plan.deltas.some((delta) =>
    delta.ruleId === "AVP014" && delta.disposition === "HOLD" && delta.after?.action === "hook.execute"
  ));

  const model = fixture();
  json(model.repo, ".agent-vigil-authority-plan.json", {
    schemaVersion: 1,
    approvedAdditions: [],
    allowUnknownChanges: true,
  });
  write(model.repo, ".codex/config.toml", 'model = "vendor/latest"\n');
  const modelBase = commit(model.repo, "trusted policy and mutable model");
  write(model.repo, ".codex/config.toml", 'model = "vendor/default"\n');
  const modelHead = commit(model.repo, "change mutable model");
  const modelPlan = buildAuthorityPlan(model.repo, modelBase, modelHead);

  assert.equal(modelPlan.status, "HOLD");
  assert.equal(modelPlan.summary.approved, 0);
  assert.ok(modelPlan.deltas.some((delta) =>
    delta.ruleId === "AVP014" && delta.disposition === "HOLD" && delta.after?.action === "model.select"
  ));
});

test("plan CLI writes private deterministic output and returns fail-closed exit codes", () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { mcpServers: { risky: { command: "node" } } });
  const head = commit(value.repo, "add mcp");
  const output = join(value.repo, "plan.json");

  assert.equal(run(["plan", "--repo", value.repo, "--base", value.base, "--head", head, "--json", "--output", output]), 1);
  const plan = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(plan.status, "BLOCK");
  if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(run(["plan", "--repo", value.repo, "--base", "missing", "--head", head]), 2);
});

test("composite Action enforces an exact-SHA authority plan as a required check", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const value = fixture();
  json(value.repo, ".mcp.json", { mcpServers: { deploy: { command: "node", args: ["server.js"] } } });
  const head = commit(value.repo, "add deploy server");
  const auxiliary = mkdtempSync(join(tmpdir(), "vigil-plan-action-"));
  const event = join(auxiliary, "event.json");
  const output = join(auxiliary, "output");
  const summary = join(auxiliary, "summary");
  const runner = join(auxiliary, "runner");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: value.base }, head: { sha: head } } }));
  writeFileSync(output, "");
  writeFileSync(summary, "");
  mkdirSync(runner);

  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]+)$/)?.[1];
  assert.ok(block);
  const script = join(auxiliary, "run.sh");
  writeFileSync(script, block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(), GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner, VIGIL_MODE: "plan", VIGIL_ATTEST: "false",
    VIGIL_TRANSCRIPT: "", VIGIL_RECEIPT: "", VIGIL_AUTHORITY_CONTRACT: "", VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_OUTCOME_RECEIPT: "", VIGIL_ACTIONS_RUN_ID: "", VIGIL_REPO: value.repo,
    VIGIL_BASE: value.base, VIGIL_HEAD: head, VIGIL_TEST_CMD: "", VIGIL_POLICY: "", VIGIL_POLICY_REF: "",
    VIGIL_STRICT: "true", VIGIL_MIN_VERIFIED: "1", VIGIL_GITHUB_TOKEN: "",
    VIGIL_VALUE_TASK_CLASS: "", VIGIL_VALUE_BUDGET_USD: "", VIGIL_VALUE_COST_USD: "",
    VIGIL_VALUE_COST_SOURCE: "", VIGIL_VALUE_COST_EVIDENCE: "", VIGIL_VALUE_REVIEW_MINUTES: "",
    VIGIL_REVERT_EVIDENCE: "", VIGIL_HOTFIX_EVIDENCE: "", VIGIL_INCIDENT_EVIDENCE: "",
  };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], { cwd: value.repo, encoding: "utf8", env });
  assert.equal(completed.status, 1, `${completed.stdout}\n${completed.stderr}`);
  assert.match(readFileSync(output, "utf8"), /^status=BLOCK$/m);
  assert.match(readFileSync(output, "utf8"), /^receipt_hash=sha256:[a-f0-9]{64}$/m);
  assert.match(readFileSync(output, "utf8"), /^sarif=$/m);
  assert.match(readFileSync(output, "utf8"), /^value_card=$/m);
  const report = JSON.parse(readFileSync(join(value.repo, "agent-vigil-report.json"), "utf8"));
  assert.equal(report.status, "BLOCK");
  assert.equal(report.base, value.base);
  assert.equal(report.head, head);

  const attested = spawnSync("bash", [script], { cwd: value.repo, encoding: "utf8", env: { ...env, VIGIL_ATTEST: "true" } });
  assert.equal(attested.status, 2);
  assert.match(attested.stderr, /plan mode does not yet support attestation/);
});

test("the published plan schema is parseable and names the implemented contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../docs/authority-plan-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.schemaVersion.const, "agent-vigil-authority-plan/v1");
  assert.deepEqual(schema.properties.status.enum, ["PASS", "BLOCK", "HOLD"]);
  assert.equal(schema.additionalProperties, false);
});

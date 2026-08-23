#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { buildAuthorityPlan, type AuthorityPlatform, type PlanStatus } from "../src/authority-plan.ts";
import { writePrivateFileAtomic } from "../src/safe-output.ts";

type SearchItem = { path: string; repository: { full_name: string; private?: boolean } };
type CommitItem = { sha: string; parents?: Array<{ sha: string }> };
type Candidate = { repository: string; path: string; platform: AuthorityPlatform };
type CorpusCase = {
  id: string;
  labelStatus: "UNREVIEWED_NATURAL_CHANGE";
  platform: AuthorityPlatform;
  repository: string;
  path: string;
  base: string;
  head: string;
  sourceUrl: string;
  baseBlobSha256: string | null;
  headBlobSha256: string;
  observed: {
    status: PlanStatus;
    changes: number;
    expansions: number;
    contractions: number;
    incomparable: number;
    blocking: number;
    holds: number;
  };
  planted: {
    mutation: string;
    expected: "BLOCK";
    observed: PlanStatus;
    matched: boolean;
    blockingRuleIds: string[];
  };
};

const SUPPORTED = new Map<string, AuthorityPlatform>([
  [".mcp.json", "mcp"],
  ["mcp.json", "mcp"],
  [".vscode/mcp.json", "mcp"],
  [".cursor/mcp.json", "mcp"],
  [".github/mcp.json", "mcp"],
  [".github/copilot/mcp.json", "mcp"],
  [".claude/settings.json", "claude-code"],
  [".claude/settings.local.json", "claude-code"],
  [".codex/config.toml", "codex"],
]);

const SEARCHES = [
  "mcpServers filename:.mcp.json",
  "servers filename:mcp.json",
  "permissions filename:settings.json path:.claude",
  "sandbox_mode filename:config.toml path:.codex",
  "approval_policy filename:config.toml path:.codex",
];
const SEARCH_PAGES = 2;
const SEARCH_DELAY_MS = 7_000;
const SEARCH_CACHE = join(tmpdir(), "agent-vigil-authority-search-v1.json");

const DIRECT_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ghJson(endpoint: string, fields: Record<string, string>): unknown {
  const args = ["api", "-X", "GET", endpoint];
  for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value}`);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }));
}

function ghSearch(query: string, page: number): SearchItem[] {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = ghJson("search/code", { q: query, per_page: "100", page: String(page) }) as { items?: SearchItem[] };
      return response.items ?? [];
    } catch (error) {
      if (attempt === 2) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65_000);
    }
  }
  return [];
}

function ghRaw(repository: string, path: string, ref: string): string | null {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const result = spawnSync("gh", [
    "api", "-X", "GET", "-H", "Accept: application/vnd.github.raw+json",
    `repos/${repository}/contents/${encoded}`, "-f", `ref=${ref}`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  if (result.stderr.includes("HTTP 404")) return null;
  throw new Error(`GitHub content request failed for ${repository}/${path}@${ref}`);
}

function containsCredential(value: string): boolean {
  if (DIRECT_SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/(?:token|secret|password|passphrase|api[_-]?key|authorization)["']?\s*[:=]\s*["']([^"']{8,})["']/i);
    if (!match) continue;
    const candidate = match[1].trim();
    if (/^(?:\$\{|\$[A-Z_]|env:|process\.env|example|placeholder|replace|your[_ -]|<)/i.test(candidate)) continue;
    return true;
  }
  return false;
}

function collectCandidates(): Candidate[] {
  const unique = new Map<string, Candidate>();
  const cache = existsSync(SEARCH_CACHE)
    ? JSON.parse(readFileSync(SEARCH_CACHE, "utf8")) as Record<string, SearchItem[]>
    : {};
  let liveSearches = 0;
  for (const query of SEARCHES) {
    for (let page = 1; page <= SEARCH_PAGES; page += 1) {
      const cacheKey = `${query}\0${page}`;
      let items = cache[cacheKey];
      if (!items) {
        if (liveSearches > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SEARCH_DELAY_MS);
        items = ghSearch(query, page);
        cache[cacheKey] = items;
        writePrivateFileAtomic(SEARCH_CACHE, `${JSON.stringify(cache)}\n`);
        liveSearches += 1;
      }
      for (const item of items) {
        const platform = SUPPORTED.get(item.path);
        if (!platform || item.repository.private) continue;
        const key = `${item.repository.full_name}\0${item.path}`;
        unique.set(key, { repository: item.repository.full_name, path: item.path, platform });
      }
      if (items.length < 100) break;
    }
  }
  return [...unique.values()].sort((a, b) => `${a.platform}:${a.repository}:${a.path}`.localeCompare(`${b.platform}:${b.repository}:${b.path}`));
}

function replay(path: string, baseContent: string | null, headContent: string): ReturnType<typeof buildAuthorityPlan> {
  const repo = mkdtempSync(join(tmpdir(), "vigil-authority-corpus-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "corpus@example.test");
    git(repo, "config", "user.name", "Authority Corpus");
    writeFileSync(join(repo, "README.md"), "config-only replay\n");
    if (baseContent !== null) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), baseContent);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), headContent);
    git(repo, "add", "-A");
    if (!git(repo, "status", "--porcelain")) throw new Error("revision pair has identical supported-file content");
    git(repo, "commit", "-qm", "head");
    return buildAuthorityPlan(repo, base, git(repo, "rev-parse", "HEAD"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function plantExpansion(platform: AuthorityPlatform, raw: string, index: number): { content: string; mutation: string } {
  const unique = `agent-vigil-planted-${index}`;
  if (platform === "codex") {
    const parsed = objectValue(parseToml(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw));
    if (parsed.sandbox_mode !== "danger-full-access") {
      parsed.sandbox_mode = "danger-full-access";
      return { content: stringifyToml(parsed), mutation: "codex:sandbox-mode-danger-full-access" };
    }
    const servers = objectValue(parsed.mcp_servers);
    servers[unique] = { command: "node", args: ["agent-vigil-planted-server.js"] };
    parsed.mcp_servers = servers;
    return { content: stringifyToml(parsed), mutation: "codex:add-mcp-server" };
  }

  const parsed = objectValue(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw));
  if (platform === "mcp") {
    const servers = objectValue(parsed.mcpServers ?? parsed.servers);
    servers[unique] = { command: "node", args: ["agent-vigil-planted-server.js"] };
    parsed.mcpServers = servers;
    return { content: `${JSON.stringify(parsed, null, 2)}\n`, mutation: "mcp:add-server" };
  }

  if (index % 2 === 0) {
    const plugins = objectValue(parsed.enabledPlugins);
    plugins[`${unique}@example`] = true;
    parsed.enabledPlugins = plugins;
    return { content: `${JSON.stringify(parsed, null, 2)}\n`, mutation: "claude-code:enable-plugin" };
  }
  const permissions = objectValue(parsed.permissions);
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  allow.push(`Bash(${unique}:*)`);
  permissions.allow = allow;
  parsed.permissions = permissions;
  return { content: `${JSON.stringify(parsed, null, 2)}\n`, mutation: "claude-code:add-preauthorized-command" };
}

function parsePositiveInteger(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function main(): void {
  const target = parsePositiveInteger("--target", 100);
  const outputIndex = process.argv.indexOf("--output");
  const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : "docs/research/authority-revision-corpus-v1.json");
  const perRepository = parsePositiveInteger("--max-per-repository", 2);
  const candidates = collectCandidates();
  const cases: CorpusCase[] = [];
  const repositoryCounts = new Map<string, number>();
  const platformTargets: Record<AuthorityPlatform, number> = {
    mcp: Math.floor(target / 3),
    "claude-code": Math.floor(target / 3),
    codex: target - (2 * Math.floor(target / 3)),
  };
  const platformCounts: Record<AuthorityPlatform, number> = { mcp: 0, "claude-code": 0, codex: 0 };
  const exclusions: Record<string, number> = { missingHead: 0, noParent: 0, identical: 0, credential: 0, request: 0 };

  for (const candidate of candidates) {
    if (cases.length >= target) break;
    if (platformCounts[candidate.platform] >= platformTargets[candidate.platform]) continue;
    if ((repositoryCounts.get(candidate.repository) ?? 0) >= perRepository) continue;
    let commits: CommitItem[];
    try {
      commits = ghJson(`repos/${candidate.repository}/commits`, { path: candidate.path, per_page: "6" }) as CommitItem[];
    } catch {
      exclusions.request += 1;
      continue;
    }
    for (const commit of commits) {
      if (cases.length >= target || platformCounts[candidate.platform] >= platformTargets[candidate.platform] || (repositoryCounts.get(candidate.repository) ?? 0) >= perRepository) break;
      const parent = commit.parents?.[0]?.sha;
      if (!parent) { exclusions.noParent += 1; continue; }
      let baseContent: string | null;
      let headContent: string | null;
      try {
        baseContent = ghRaw(candidate.repository, candidate.path, parent);
        headContent = ghRaw(candidate.repository, candidate.path, commit.sha);
      } catch {
        exclusions.request += 1;
        continue;
      }
      if (headContent === null) { exclusions.missingHead += 1; continue; }
      if (baseContent === headContent) { exclusions.identical += 1; continue; }
      if (containsCredential(headContent) || (baseContent !== null && containsCredential(baseContent))) {
        exclusions.credential += 1;
        continue;
      }
      let plan: ReturnType<typeof buildAuthorityPlan>;
      try { plan = replay(candidate.path, baseContent, headContent); }
      catch { exclusions.request += 1; continue; }
      let planted: CorpusCase["planted"];
      try {
        const mutation = plantExpansion(candidate.platform, headContent, cases.length);
        const plantedPlan = replay(candidate.path, headContent, mutation.content);
        const blockingRuleIds = [...new Set(plantedPlan.deltas.filter((delta) => delta.disposition === "BLOCK").map((delta) => delta.ruleId))].sort();
        planted = {
          mutation: mutation.mutation,
          expected: "BLOCK",
          observed: plantedPlan.status,
          matched: plantedPlan.status === "BLOCK",
          blockingRuleIds,
        };
      } catch {
        exclusions.request += 1;
        continue;
      }
      const identity = `${candidate.repository}\0${candidate.path}\0${parent}\0${commit.sha}`;
      cases.push({
        id: `natural:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
        labelStatus: "UNREVIEWED_NATURAL_CHANGE",
        platform: candidate.platform,
        repository: candidate.repository,
        path: candidate.path,
        base: parent,
        head: commit.sha,
        sourceUrl: `https://github.com/${candidate.repository}/compare/${parent}...${commit.sha}`,
        baseBlobSha256: baseContent === null ? null : sha256(baseContent),
        headBlobSha256: sha256(headContent),
        observed: {
          status: plan.status,
          changes: plan.summary.changes,
          expansions: plan.summary.expansions,
          contractions: plan.summary.contractions,
          incomparable: plan.summary.incomparable,
          blocking: plan.summary.blocking,
          holds: plan.summary.holds,
        },
        planted,
      });
      repositoryCounts.set(candidate.repository, (repositoryCounts.get(candidate.repository) ?? 0) + 1);
      platformCounts[candidate.platform] += 1;
    }
  }

  const byStatus = { PASS: 0, BLOCK: 0, HOLD: 0 };
  const byPlatform = { mcp: 0, "claude-code": 0, codex: 0 };
  for (const item of cases) { byStatus[item.observed.status] += 1; byPlatform[item.platform] += 1; }
  const plantedMisses = cases.filter((item) => !item.planted.matched).length;
  const manifest = {
    schemaVersion: "agent-vigil-authority-corpus/v1",
    observedAt: new Date().toISOString(),
    status: cases.length !== target
      ? "INCOMPLETE_UNREVIEWED"
      : plantedMisses
        ? "COMPLETE_WITH_PLANTED_MISSES"
        : "COMPLETE_UNREVIEWED_NATURAL_WITH_PLANTED_PASS",
    target,
    counts: {
      cases: cases.length,
      repositories: repositoryCounts.size,
      candidates: candidates.length,
      byPlatform,
      byStatus,
      planted: { cases: cases.length, expectedBlocks: cases.length, observedBlocks: cases.length - plantedMisses, misses: plantedMisses },
      exclusions,
    },
    selection: {
      source: "GitHub public code search and immutable commit identifiers",
      searches: SEARCHES,
      platformTargets,
      maximumPairsPerRepository: perRepository,
      contentHandling: "Configuration bytes were processed in temporary repositories and were not retained in this ledger.",
      credentialHandling: "Secret-looking samples were excluded before replay; absence from this ledger is not proof that public sources contain no secrets.",
    },
    cases,
    limitations: [
      "Cases are natural public revisions but labels remain UNREVIEWED_NATURAL_CHANGE.",
      "Natural decisions prove parser and deterministic execution coverage, not detection accuracy or maintainer usefulness.",
      "Planted cases test known synthetic authority expansions applied to pinned real configurations; they do not estimate the natural miss rate.",
      "Config-only replay excludes unrelated files, user settings, managed policy, runtime tools, credentials, and provider-side grants.",
      "GitHub search ranking is not a representative sample of all agent configurations.",
    ],
  };
  mkdirSync(dirname(output), { recursive: true });
  writePrivateFileAtomic(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest.counts, null, 2)}\n`);
  if (cases.length !== target) process.exitCode = 2;
  else if (plantedMisses) process.exitCode = 1;
}

main();

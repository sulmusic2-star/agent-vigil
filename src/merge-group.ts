import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadPolicy } from "./config.ts";
import {
  checkIntegrity,
  checkTestsPass,
  checkWorkspaceBinding,
  checkWorkspaceMutation,
  gitRefExists,
  resolveGitRef,
} from "./detectors/reality.ts";
import { routeIntegrity } from "./integrity-policy.ts";
import { buildReport, type CheckResult, type Claim, type TrustReport } from "./report.ts";

type MergeGroupPayload = {
  action?: string;
  merge_group?: {
    base_sha?: string;
    head_sha?: string;
    base_ref?: string;
    head_ref?: string;
  };
  repository?: { full_name?: string };
};

export type MergeGroupOptions = {
  repo: string;
  eventPath: string;
  base: string;
  head: string;
  policy?: string;
  policyRef?: string;
};

export function loadMergeGroupEvent(path: string): MergeGroupPayload & {
  merge_group: { base_sha: string; head_sha: string; base_ref?: string; head_ref?: string };
} {
  const value = JSON.parse(readFileSync(path, "utf8")) as MergeGroupPayload;
  if (!value.merge_group?.base_sha || !value.merge_group?.head_sha) {
    throw new Error("event is not a merge_group payload with base_sha and head_sha");
  }
  return value as MergeGroupPayload & {
    merge_group: { base_sha: string; head_sha: string; base_ref?: string; head_ref?: string };
  };
}

function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return undefined; }
}

function result(subject: string, verdict: CheckResult["verdict"], evidence: string, ruleId: string, blocksPass = false): CheckResult {
  return {
    claim: { kind: "integrity", quote: "GitHub merge queue verification", subject },
    verdict,
    evidence,
    ruleId,
    ...(verdict === "verified" ? {} : { contributesToPass: false }),
    ...(blocksPass ? { blocksPass: true } : {}),
  };
}

export function buildMergeGroupReport(options: MergeGroupOptions): TrustReport {
  const repo = resolve(options.repo);
  const eventPath = resolve(options.eventPath);
  const event = loadMergeGroupEvent(eventPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  if (resolveGitRef(repo, event.merge_group.base_sha) !== base) {
    throw new Error(`event base ${event.merge_group.base_sha} does not match selected base ${base}`);
  }
  if (resolveGitRef(repo, event.merge_group.head_sha) !== head) {
    throw new Error(`event head ${event.merge_group.head_sha} does not match selected head ${head}`);
  }

  const policy = loadPolicy(repo, options.policy, options.policyRef);
  if (policy.ref && resolveGitRef(repo, policy.ref) !== base) {
    throw new Error(`merge-group policy-ref ${policy.ref} does not match event base ${base}`);
  }
  const eventHash = `sha256:${createHash("sha256").update(readFileSync(eventPath)).digest("hex")}`;
  const inputs = [eventPath, ...(policy.path ? [policy.path] : [])];
  const results: CheckResult[] = [];
  const advisories: CheckResult[] = [];

  results.push(result(
    "merge-group event is bound to the selected commits",
    "verified",
    `GitHub event binds base ${base} and merge-group head ${head}`,
    "merge-group-binding",
  ));
  const ancestor = git(repo, ["merge-base", "--is-ancestor", base, head]) !== undefined;
  results.push(result(
    "merge-group head descends from its target base",
    ancestor ? "verified" : "contradicted",
    ancestor ? `${base} is an ancestor of ${head}` : `${base} is not an ancestor of ${head}`,
    "merge-group-range",
  ));
  results.push(...checkWorkspaceBinding(repo, head, inputs));
  const testClaim: Claim = {
    kind: "tests_pass",
    quote: "trusted base policy verification passes on the composed merge-group commit",
    subject: "merge-group test command",
  };
  results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand));
  results.push(...checkWorkspaceMutation(repo, inputs, head));
  const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
  results.push(...integrity.results);
  advisories.push(...integrity.advisories);

  const policySource = policy.ref && policy.gitPath
    ? `${policy.gitPath}@${policy.ref}`
    : policy.path ? relative(repo, policy.path) : undefined;
  const remote = git(repo, ["config", "--get", "remote.origin.url"]);
  const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
  const eventName = relative(repo, eventPath) || eventPath;
  const reproduction = [
    "vigil merge-group", "--event", `'${eventName.replace(/'/g, `'"'"'`)}'`, "--repo .", "--base", base, "--head", head,
    ...(policy.gitPath ? ["--policy", `'${policy.gitPath}'`] : []),
    ...(policy.ref ? ["--policy-ref", policy.ref] : []),
  ].join(" ");

  return buildReport({
    transcript: eventName,
    transcriptSha256: eventHash,
    transcriptFormat: "github-merge-group-event",
    repo,
    base,
    head,
    results,
    advisories,
    policy: {
      minVerified: policy.value.minVerified ?? 1,
      strict: true,
      source: policySource,
      sha256: policy.sha256,
    },
    repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
    reproduction,
  });
}

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { canonical } from "./report.ts";
import type { ChangeOutcome, MaintainerDisposition } from "./value.ts";

export type GitHubEvidenceSourceKind =
  | "event" | "pull-request" | "reviews" | "review-comments" | "actions-run"
  | "actions-jobs" | "revert-commit" | "hotfix-pull-request" | "incident-issue";

export type GitHubEvidenceBundle = {
  schemaVersion: "agent-vigil-github-evidence/v1";
  generatedAt: string;
  evidenceHash: string;
  repository?: string;
  pullRequest?: {
    number: number;
    state: "open" | "closed";
    merged: boolean;
    baseSha?: string;
    headSha?: string;
    mergeCommitSha?: string;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string;
    mergedAt?: string;
  };
  reviews?: {
    records: number;
    reviewers: number;
    approved: number;
    changesRequested: number;
    dismissed: number;
    commented: number;
    latestSubmittedAt?: string;
  };
  reviewComments?: { records: number };
  actions?: {
    runId?: number;
    attempt?: number;
    status?: string;
    conclusion?: string;
    startedAt?: string;
    completedAt?: string;
    runDurationSeconds?: number;
    jobs?: number;
    jobDurationSeconds?: number;
    failedJobs?: number;
    billing: "UNAVAILABLE";
  };
  markers: {
    revert: boolean;
    hotfix: boolean;
    incident: boolean;
  };
  inference: {
    disposition: MaintainerDisposition;
    outcome: ChangeOutcome;
    outcomeAsOf?: string;
    reviewEvidence: "UNAVAILABLE" | "EVIDENCE_HASHED";
    outcomeEvidence: "UNAVAILABLE" | "EVIDENCE_HASHED";
  };
  sources: Array<{
    kind: GitHubEvidenceSourceKind;
    file: string;
    bytes: number;
    sha256: string;
  }>;
};

export type GitHubEvidenceInputs = Partial<Record<GitHubEvidenceSourceKind, string>> & { event: string };

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function durationSeconds(start: unknown, end: unknown): number | undefined {
  const from = timestamp(start);
  const to = timestamp(end);
  if (!from || !to) return undefined;
  const duration = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return duration >= 0 ? duration : undefined;
}

function readSource(path: string, kind: GitHubEvidenceSourceKind): { value: any; source: GitHubEvidenceBundle["sources"][number] } {
  const absolute = resolve(path);
  const bytes = statSync(absolute).size;
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`GitHub ${kind} evidence is ${bytes} bytes; maximum is ${MAX_SOURCE_BYTES}`);
  const raw = readFileSync(absolute);
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`GitHub ${kind} evidence is not valid JSON: ${path}`); }
  return {
    value,
    source: { kind, file: basename(path), bytes, sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}` },
  };
}

function pullObject(value: any): any {
  return value?.pull_request && typeof value.pull_request === "object" ? value.pull_request : value;
}

function parsePull(value: any, event?: any): GitHubEvidenceBundle["pullRequest"] | undefined {
  const pull = pullObject(value);
  const number = integer(pull?.number ?? event?.number ?? event?.pull_request?.number);
  if (number === undefined) return undefined;
  const state = pull?.state === "closed" ? "closed" : pull?.state === "open" ? "open" : undefined;
  if (!state) throw new Error("GitHub pull-request evidence state must be open or closed");
  return {
    number,
    state,
    merged: pull?.merged === true || Boolean(pull?.merged_at),
    ...(typeof pull?.base?.sha === "string" ? { baseSha: pull.base.sha } : {}),
    ...(typeof pull?.head?.sha === "string" ? { headSha: pull.head.sha } : {}),
    ...(typeof pull?.merge_commit_sha === "string" ? { mergeCommitSha: pull.merge_commit_sha } : {}),
    ...(timestamp(pull?.created_at) ? { createdAt: timestamp(pull.created_at) } : {}),
    ...(timestamp(pull?.updated_at) ? { updatedAt: timestamp(pull.updated_at) } : {}),
    ...(timestamp(pull?.closed_at) ? { closedAt: timestamp(pull.closed_at) } : {}),
    ...(timestamp(pull?.merged_at) ? { mergedAt: timestamp(pull.merged_at) } : {}),
  };
}

function parseReviews(value: any): NonNullable<GitHubEvidenceBundle["reviews"]> {
  if (!Array.isArray(value)) throw new Error("GitHub reviews evidence must be an array");
  if (value.length > 10_000) throw new Error("GitHub reviews evidence contains more than 10000 records");
  const latest = new Map<string, { state: string; submittedAt?: string }>();
  let anonymous = 0;
  for (const review of value) {
    const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
    if (!new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]).has(state)) continue;
    const login = typeof review?.user?.login === "string" && review.user.login ? review.user.login.toLowerCase() : `anonymous-${anonymous++}`;
    const submittedAt = timestamp(review?.submitted_at);
    const previous = latest.get(login);
    if (!previous || !previous.submittedAt || (submittedAt && submittedAt >= previous.submittedAt)) latest.set(login, { state, ...(submittedAt ? { submittedAt } : {}) });
  }
  const states = [...latest.values()];
  const dates = states.map((item) => item.submittedAt).filter((item): item is string => Boolean(item)).sort();
  return {
    records: value.length,
    reviewers: states.length,
    approved: states.filter((item) => item.state === "APPROVED").length,
    changesRequested: states.filter((item) => item.state === "CHANGES_REQUESTED").length,
    dismissed: states.filter((item) => item.state === "DISMISSED").length,
    commented: states.filter((item) => item.state === "COMMENTED").length,
    ...(dates.length ? { latestSubmittedAt: dates.at(-1) } : {}),
  };
}

function parseComments(value: any): NonNullable<GitHubEvidenceBundle["reviewComments"]> {
  if (!Array.isArray(value)) throw new Error("GitHub review-comments evidence must be an array");
  if (value.length > 100_000) throw new Error("GitHub review-comments evidence contains more than 100000 records");
  return { records: value.length };
}

function parseActions(run: any, jobsValue?: any): NonNullable<GitHubEvidenceBundle["actions"]> {
  const jobs = jobsValue === undefined ? [] : Array.isArray(jobsValue) ? jobsValue : Array.isArray(jobsValue?.jobs) ? jobsValue.jobs : undefined;
  if (jobs === undefined) throw new Error("GitHub actions-jobs evidence must be an array or an object with jobs");
  if (jobs.length > 10_000) throw new Error("GitHub actions-jobs evidence contains more than 10000 jobs");
  const jobDurations: number[] = jobs.map((job: any) => durationSeconds(job?.started_at, job?.completed_at)).filter((value: unknown): value is number => typeof value === "number");
  const startedAt = timestamp(run?.run_started_at ?? run?.created_at);
  const completedAt = timestamp(run?.updated_at);
  return {
    ...(integer(run?.id) !== undefined ? { runId: integer(run.id) } : {}),
    ...(integer(run?.run_attempt) !== undefined ? { attempt: integer(run.run_attempt) } : {}),
    ...(typeof run?.status === "string" ? { status: run.status } : {}),
    ...(typeof run?.conclusion === "string" ? { conclusion: run.conclusion } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationSeconds(startedAt, completedAt) !== undefined ? { runDurationSeconds: durationSeconds(startedAt, completedAt) } : {}),
    ...(jobsValue !== undefined ? {
      jobs: jobs.length,
      jobDurationSeconds: jobDurations.reduce((sum, value) => sum + value, 0),
      failedJobs: jobs.filter((job: any) => new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]).has(String(job?.conclusion))).length,
    } : {}),
    billing: "UNAVAILABLE",
  };
}

function labelNames(value: any): string[] {
  return Array.isArray(value?.labels) ? value.labels.map((label: any) => typeof label === "string" ? label : label?.name).filter((label: unknown): label is string => typeof label === "string") : [];
}

function validateRevert(value: any): void {
  if (typeof value?.sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(value.sha) || typeof value?.commit !== "object") {
    throw new Error("GitHub revert evidence must be a commit object with a full SHA");
  }
  const message = typeof value.commit?.message === "string" ? value.commit.message : "";
  if (!/^Revert\b/im.test(message) && !/This reverts commit [0-9a-f]{7,40}/i.test(message)) {
    throw new Error("GitHub revert evidence commit message does not identify a revert");
  }
}

function validateHotfix(value: any): void {
  const pull = parsePull(value);
  if (!pull?.merged || !labelNames(pullObject(value)).some((label) => /^(?:hotfix|emergency[- ]fix)$/i.test(label))) {
    throw new Error("GitHub hotfix evidence must be a merged pull request labeled hotfix or emergency-fix");
  }
}

function validateIncident(value: any): void {
  if (integer(value?.number) === undefined || !new Set(["open", "closed"]).has(value?.state) || value?.pull_request) {
    throw new Error("GitHub incident evidence must be an issue object");
  }
  if (!labelNames(value).some((label) => /^(?:incident|outage|sev[- ]?[0-9])/i.test(label))) {
    throw new Error("GitHub incident evidence must carry an incident, outage, or severity label");
  }
}

function payloadWithoutHash(bundle: Omit<GitHubEvidenceBundle, "evidenceHash">): string {
  const { generatedAt: _generatedAt, ...evidence } = bundle;
  return canonical(evidence);
}

export function recomputeGitHubEvidenceHash(bundle: GitHubEvidenceBundle): string {
  const { evidenceHash: _hash, ...withoutHash } = bundle;
  return `sha256:${createHash("sha256").update(payloadWithoutHash(withoutHash)).digest("hex")}`;
}

export function buildGitHubEvidence(inputs: GitHubEvidenceInputs): GitHubEvidenceBundle {
  const sources: GitHubEvidenceBundle["sources"] = [];
  const loaded = new Map<GitHubEvidenceSourceKind, any>();
  for (const [kind, path] of Object.entries(inputs) as Array<[GitHubEvidenceSourceKind, string]>) {
    if (!path) continue;
    const item = readSource(path, kind);
    loaded.set(kind, item.value);
    sources.push(item.source);
  }
  const event = loaded.get("event");
  const repository = typeof event?.repository?.full_name === "string" ? event.repository.full_name : undefined;
  const pull = loaded.has("pull-request") ? parsePull(loaded.get("pull-request"), event) : parsePull(event, event);
  const reviews = loaded.has("reviews") ? parseReviews(loaded.get("reviews")) : undefined;
  const reviewComments = loaded.has("review-comments") ? parseComments(loaded.get("review-comments")) : undefined;
  const actions = loaded.has("actions-run") || loaded.has("actions-jobs")
    ? parseActions(loaded.get("actions-run") ?? {}, loaded.get("actions-jobs")) : undefined;
  if (loaded.has("revert-commit")) validateRevert(loaded.get("revert-commit"));
  if (loaded.has("hotfix-pull-request")) validateHotfix(loaded.get("hotfix-pull-request"));
  if (loaded.has("incident-issue")) validateIncident(loaded.get("incident-issue"));
  const markers = { revert: loaded.has("revert-commit"), hotfix: loaded.has("hotfix-pull-request"), incident: loaded.has("incident-issue") };
  const disposition: MaintainerDisposition = reviews?.changesRequested
    ? "changes-requested" : reviews?.approved || pull?.merged ? "accepted" : "unreviewed";
  const outcome: ChangeOutcome = markers.incident ? "incident-linked" : markers.revert ? "reverted" : markers.hotfix ? "hotfixed" : pull?.merged ? "merged" : pull?.state === "closed" ? "closed" : "unknown";
  const dates = [
    markers.incident ? timestamp(loaded.get("incident-issue")?.updated_at ?? loaded.get("incident-issue")?.created_at) : undefined,
    markers.revert ? timestamp(loaded.get("revert-commit")?.commit?.committer?.date ?? loaded.get("revert-commit")?.commit?.author?.date) : undefined,
    markers.hotfix ? timestamp(pullObject(loaded.get("hotfix-pull-request"))?.merged_at ?? pullObject(loaded.get("hotfix-pull-request"))?.closed_at) : undefined,
    pull?.mergedAt, pull?.closedAt,
  ].filter((item): item is string => Boolean(item)).sort();
  const withoutHash: Omit<GitHubEvidenceBundle, "evidenceHash"> = {
    schemaVersion: "agent-vigil-github-evidence/v1",
    generatedAt: new Date().toISOString(),
    ...(repository ? { repository } : {}),
    ...(pull ? { pullRequest: pull } : {}),
    ...(reviews ? { reviews } : {}),
    ...(reviewComments ? { reviewComments } : {}),
    ...(actions ? { actions } : {}),
    markers,
    inference: {
      disposition,
      outcome,
      ...(dates.length ? { outcomeAsOf: dates.at(-1) } : {}),
      reviewEvidence: reviews || pull?.merged ? "EVIDENCE_HASHED" : "UNAVAILABLE",
      outcomeEvidence: outcome !== "unknown" ? "EVIDENCE_HASHED" : "UNAVAILABLE",
    },
    sources: sources.sort((left, right) => left.kind.localeCompare(right.kind)),
  };
  const bundle: GitHubEvidenceBundle = { ...withoutHash, evidenceHash: "" };
  bundle.evidenceHash = recomputeGitHubEvidenceHash(bundle);
  return bundle;
}

export function loadGitHubEvidence(path: string): GitHubEvidenceBundle {
  const { value } = readSource(path, "event");
  const bundle = value as GitHubEvidenceBundle;
  if (bundle?.schemaVersion !== "agent-vigil-github-evidence/v1" || typeof bundle.evidenceHash !== "string") throw new Error("GitHub evidence bundle schema is unsupported");
  if (recomputeGitHubEvidenceHash(bundle) !== bundle.evidenceHash) throw new Error("GitHub evidence bundle hash is invalid");
  return bundle;
}

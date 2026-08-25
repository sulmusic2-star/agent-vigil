import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { canonical } from "./report.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";
import { readBoundedRegularFile } from "./continuity/contracts.ts";

export const PUBLIC_PR_RECEIPT_SCHEMA = "agent-vigil-public-pr-receipt/v1" as const;

export type PublicPrContinuity = "CURRENT" | "HOLD" | "EXPIRED" | "REVOKED";

export type PublicPrSubject = {
  url: string;
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
};

export type PublicPrSource = {
  kind: "pull-request" | "reviews" | "check-runs" | "commit-statuses";
  endpoint: string;
  status: number;
  bytes: number;
  sha256: string;
  complete: boolean;
};

export type PublicPrSnapshot = {
  pull: Record<string, unknown>;
  reviews: unknown[];
  checkRuns: unknown[];
  statuses: unknown[];
  sources: PublicPrSource[];
  unavailable: string[];
};

export type PublicPrReceipt = {
  schemaVersion: typeof PUBLIC_PR_RECEIPT_SCHEMA;
  generatedAt: string;
  tool: {
    name: "@sulmusic/agent-vigil";
    version: string;
    commit: string;
  };
  subject: PublicPrSubject;
  observation: {
    pullRequestState: "open" | "closed";
    merged: boolean;
    approvals: number;
    changesRequested: number;
    checks: {
      total: number;
      passing: number;
      failing: number;
      pending: number;
      unknown: number;
    };
    latestEvidenceAt: string;
    freshnessReferenceAt: string | null;
    ageHours: number;
    maxAgeHours: number;
  };
  decision: {
    continuity: PublicPrContinuity;
    allowsProtectedAction: false;
    reasonCodes: string[];
    summary: string;
    nextAction: string;
  };
  claimBoundary: {
    executionObserved: true;
    sufficiencyAssessed: false;
    statement: string;
  };
  privacy: {
    publicMetadataOnly: true;
    sourceCodeFetched: false;
    sourceCodeRetained: false;
    promptsFetched: false;
    promptsRetained: false;
    transcriptsFetched: false;
    transcriptsRetained: false;
    requestBodiesSent: false;
  };
  integration: {
    mode: "read-only-public-github-api";
    repositoryWritePermission: false;
    workflowChangeRequired: false;
    secretRetention: false;
  };
  evidence: {
    sources: PublicPrSource[];
    unavailable: string[];
  };
  receiptHash: string;
  signature?: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

export type PublicPrTransportResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
};

export type PublicPrTransport = (
  url: string,
  headers: Record<string, string>,
) => Promise<PublicPrTransportResponse>;

export type CollectPublicPrOptions = {
  token?: string;
  transport?: PublicPrTransport;
};

export type BuildPublicPrReceiptOptions = {
  generatedAt: string;
  maxAgeHours: number;
  toolVersion: string;
  toolCommit: string;
};

const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_IDENTIFIER = /^sha256:[0-9a-f]{64}$/;
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SIGNING_KEY_BYTES = 64 * 1024;
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const PUBLIC_CLAIM_STATEMENT = "This receipt attests that selected public GitHub events and checks were observed. It does not establish that the checks were sufficient, that the change is safe, or that deployment is authorized.";
const SUCCESSFUL_CHECKS = new Set(["success", "neutral", "skipped"]);
const FAILED_CHECKS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);
const EFFECTIVE_REVIEW_STATES = new Set(["approved", "changes_requested", "dismissed"]);

function sha256(raw: Buffer | string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const selected = string(value);
  if (!selected) return undefined;
  const epoch = Date.parse(selected);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function lower(value: unknown): string {
  return string(value)?.toLowerCase() ?? "";
}

function exactKeys(record: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length || unsupported.length) throw new Error(`${label} has unsupported or missing fields`);
}

function boundedString(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters without control characters`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an unsupported value`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const selected = boundedString(value, label, 40);
  const epoch = Date.parse(selected);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== selected) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return selected;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from zero through ${maximum}`);
  }
  return Number(value);
}

function boundedNumber(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a finite number from zero through ${maximum}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function canonicalBase64(value: unknown, label: string, maximum: number): string {
  const selected = boundedString(value, label, maximum, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  if (Buffer.from(selected, "base64").toString("base64") !== selected) throw new Error(`${label} must be canonical base64`);
  return selected;
}

function parseJson(raw: Buffer, label: string): unknown {
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

export function parsePublicPullRequestUrl(raw: string): { owner: string; repo: string; number: number; url: string } {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("pull request URL must be an absolute https://github.com URL"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("pull request URL must be an uncredentialed https://github.com URL without query or fragment data");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) {
    throw new Error("pull request URL must match https://github.com/<owner>/<repo>/pull/<number>");
  }
  const [owner, repo] = parts;
  if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo)) throw new Error("pull request owner or repository is invalid");
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("pull request number is invalid");
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

export function validateToolCommit(value: string): string {
  if (!FULL_GIT_SHA.test(value)) throw new Error("--tool-ref must be a full lowercase Git commit SHA, not a tag or branch");
  return value;
}

export async function defaultPublicPrTransport(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
): Promise<PublicPrTransportResponse> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) throw new Error("GitHub metadata request timeout is invalid");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub metadata response exceeds the 16 MiB limit");
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          received += next.value.byteLength;
          if (received > MAX_GITHUB_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("GitHub metadata response exceeds the 16 MiB limit");
          }
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    const body = Buffer.concat(chunks, received);
    const selected: Record<string, string | undefined> = {
      link: response.headers.get("link") ?? undefined,
      "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") ?? undefined,
    };
    return { status: response.status, headers: selected, body };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`GitHub metadata request exceeded the ${timeoutMs} ms deadline`);
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

function publicRepositorySides(pull: Record<string, unknown>): { base: Record<string, unknown>; head: Record<string, unknown> } {
  const base = object(pull.base, "GitHub pull request base");
  const head = object(pull.head, "GitHub pull request head");
  const baseRepo = base.repo && typeof base.repo === "object" && !Array.isArray(base.repo)
    ? base.repo as Record<string, unknown>
    : undefined;
  const headRepo = head.repo && typeof head.repo === "object" && !Array.isArray(head.repo)
    ? head.repo as Record<string, unknown>
    : undefined;
  if (baseRepo?.private !== false || headRepo?.private !== false) {
    throw new Error("GitHub pull request response must prove that both base and head repositories are public");
  }
  return { base, head };
}

function source(kind: PublicPrSource["kind"], endpoint: string, response: PublicPrTransportResponse): PublicPrSource {
  return {
    kind,
    endpoint,
    status: response.status,
    bytes: response.body.length,
    sha256: sha256(response.body),
    complete: !/rel="next"/.test(response.headers.link ?? ""),
  };
}

export async function collectPublicPrSnapshot(rawUrl: string, options: CollectPublicPrOptions = {}): Promise<PublicPrSnapshot> {
  const target = parsePublicPullRequestUrl(rawUrl);
  const transport = options.transport ?? defaultPublicPrTransport;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-vigil-public-pr-receipt",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const api = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

  const pullEndpoint = `${api}/pulls/${target.number}`;
  const pullResponse = await transport(pullEndpoint, headers);
  if (pullResponse.status !== 200) throw new Error(`GitHub pull request lookup failed with HTTP ${pullResponse.status}`);
  const pull = object(parseJson(pullResponse.body, "GitHub pull request lookup"), "GitHub pull request response");
  const { head } = publicRepositorySides(pull);
  const headSha = string(head.sha);
  if (!headSha || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub pull request response did not contain a full head SHA");

  const endpoints: Array<{ kind: PublicPrSource["kind"]; url: string; select(value: unknown): unknown[] }> = [
    { kind: "reviews", url: `${api}/pulls/${target.number}/reviews?per_page=100`, select: array },
    { kind: "check-runs", url: `${api}/commits/${headSha}/check-runs?per_page=100`, select: (value) => array(object(value, "GitHub check-runs response").check_runs) },
    { kind: "commit-statuses", url: `${api}/commits/${headSha}/statuses?per_page=100`, select: array },
  ];
  const responses = await Promise.all(endpoints.map(async (entry) => {
    try { return { entry, response: await transport(entry.url, headers) }; }
    catch { return { entry, response: undefined }; }
  }));

  const sources: PublicPrSource[] = [source("pull-request", pullEndpoint, pullResponse)];
  const unavailable: string[] = [];
  const values = new Map<PublicPrSource["kind"], unknown[]>();
  for (const item of responses) {
    if (!item.response) {
      unavailable.push(`${item.entry.kind}:network-error`);
      values.set(item.entry.kind, []);
      continue;
    }
    const recorded = source(item.entry.kind, item.entry.url, item.response);
    sources.push(recorded);
    if (item.response.status !== 200) {
      unavailable.push(`${item.entry.kind}:http-${item.response.status}`);
      values.set(item.entry.kind, []);
      continue;
    }
    if (!recorded.complete) unavailable.push(`${item.entry.kind}:pagination-incomplete`);
    try { values.set(item.entry.kind, item.entry.select(parseJson(item.response.body, `GitHub ${item.entry.kind}`))); }
    catch { unavailable.push(`${item.entry.kind}:invalid-response`); values.set(item.entry.kind, []); }
  }
  return {
    pull,
    reviews: values.get("reviews") ?? [],
    checkRuns: values.get("check-runs") ?? [],
    statuses: values.get("commit-statuses") ?? [],
    sources,
    unavailable,
  };
}

function latestReviews(records: unknown[]): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const item of records) {
    const review = object(item, "GitHub review");
    const user = object(review.user, "GitHub review user");
    const login = lower(user.login);
    const submittedAt = timestamp(review.submitted_at);
    if (!login || !submittedAt || !EFFECTIVE_REVIEW_STATES.has(lower(review.state))) continue;
    const previous = latest.get(login);
    if (!previous || Date.parse(submittedAt) >= Date.parse(timestamp(previous.submitted_at) ?? "1970-01-01T00:00:00.000Z")) latest.set(login, review);
  }
  return [...latest.values()];
}

function checkSummary(checkRuns: unknown[], statuses: unknown[]): {
  counts: PublicPrReceipt["observation"]["checks"];
  decisiveTimestamps: string[];
} {
  const latestRuns = new Map<string, Record<string, unknown>>();
  for (const item of checkRuns) {
    const check = object(item, "GitHub check run");
    const app = check.app && typeof check.app === "object" && !Array.isArray(check.app)
      ? lower((check.app as Record<string, unknown>).slug)
      : "unknown-app";
    const name = lower(check.name) || `id-${integer(check.id) ?? latestRuns.size}`;
    const key = `${app}:${name}`;
    const selectedAt = timestamp(check.completed_at) ?? timestamp(check.started_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = latestRuns.get(key);
    const previousAt = previous ? timestamp(previous.completed_at) ?? timestamp(previous.started_at) ?? "1970-01-01T00:00:00.000Z" : undefined;
    if (!previous || Date.parse(selectedAt) >= Date.parse(previousAt!)) latestRuns.set(key, check);
  }
  const latestStatuses = new Map<string, Record<string, unknown>>();
  for (const item of statuses) {
    const status = object(item, "GitHub commit status");
    const key = lower(status.context) || `id-${integer(status.id) ?? latestStatuses.size}`;
    const selectedAt = timestamp(status.updated_at) ?? timestamp(status.created_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = latestStatuses.get(key);
    const previousAt = previous ? timestamp(previous.updated_at) ?? timestamp(previous.created_at) ?? "1970-01-01T00:00:00.000Z" : undefined;
    if (!previous || Date.parse(selectedAt) >= Date.parse(previousAt!)) latestStatuses.set(key, status);
  }
  let passing = 0;
  let failing = 0;
  let pending = 0;
  let unknown = 0;
  const decisiveTimestamps: string[] = [];
  for (const check of latestRuns.values()) {
    if (lower(check.status) !== "completed") { pending += 1; continue; }
    const conclusion = lower(check.conclusion);
    if (SUCCESSFUL_CHECKS.has(conclusion)) {
      passing += 1;
      const completedAt = timestamp(check.completed_at);
      if (completedAt) decisiveTimestamps.push(completedAt);
    }
    else if (FAILED_CHECKS.has(conclusion)) failing += 1;
    else unknown += 1;
  }
  for (const status of latestStatuses.values()) {
    const state = lower(status.state);
    if (state === "success") {
      passing += 1;
      const updatedAt = timestamp(status.updated_at) ?? timestamp(status.created_at);
      if (updatedAt) decisiveTimestamps.push(updatedAt);
    }
    else if (state === "pending") pending += 1;
    else if (FAILED_CHECKS.has(state)) failing += 1;
    else unknown += 1;
  }
  return {
    counts: { total: passing + failing + pending + unknown, passing, failing, pending, unknown },
    decisiveTimestamps,
  };
}

function latestEvidenceAt(snapshot: PublicPrSnapshot): string {
  const candidates: string[] = [];
  for (const value of [snapshot.pull.updated_at, snapshot.pull.closed_at, snapshot.pull.merged_at]) {
    const selected = timestamp(value);
    if (selected) candidates.push(selected);
  }
  for (const value of [...snapshot.reviews, ...snapshot.checkRuns, ...snapshot.statuses]) {
    const record = object(value, "GitHub evidence record");
    for (const selected of [record.submitted_at, record.completed_at, record.updated_at, record.created_at]) {
      const parsed = timestamp(selected);
      if (parsed) candidates.push(parsed);
    }
  }
  if (!candidates.length) throw new Error("GitHub evidence did not contain a usable timestamp");
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function unsignedReceipt(snapshot: PublicPrSnapshot, rawUrl: string, options: BuildPublicPrReceiptOptions): Omit<PublicPrReceipt, "receiptHash" | "signature"> {
  const target = parsePublicPullRequestUrl(rawUrl);
  const generatedAtEpoch = Date.parse(options.generatedAt);
  if (!Number.isFinite(generatedAtEpoch) || new Date(generatedAtEpoch).toISOString() !== options.generatedAt) throw new Error("generatedAt must be canonical RFC3339 UTC");
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0 || options.maxAgeHours > 24 * 365) throw new Error("maxAgeHours must be greater than zero and no more than one year");
  validateToolCommit(options.toolCommit);

  const pull = snapshot.pull;
  const { base, head } = publicRepositorySides(pull);
  const baseSha = string(base.sha);
  const headSha = string(head.sha);
  if (!baseSha || !FULL_GIT_SHA.test(baseSha) || !headSha || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub pull request response must contain full base and head SHAs");
  const pullState = lower(pull.state);
  if (pullState !== "open" && pullState !== "closed") throw new Error("GitHub pull request state is unsupported");
  const merged = Boolean(pull.merged_at ?? pull.merged);
  const reviews = latestReviews(snapshot.reviews);
  const approvedReviews = reviews.filter((review) => lower(review.state) === "approved");
  const approvals = approvedReviews.length;
  const changesRequested = reviews.filter((review) => lower(review.state) === "changes_requested").length;
  const checkEvidence = checkSummary(snapshot.checkRuns, snapshot.statuses);
  const checks = checkEvidence.counts;
  const latestAt = latestEvidenceAt(snapshot);
  const mergeAt = merged ? timestamp(pull.merged_at) : undefined;
  const latestApprovalAt = approvedReviews
    .map((review) => timestamp(review.submitted_at))
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const decisiveTimestamps = [mergeAt, latestApprovalAt, ...checkEvidence.decisiveTimestamps]
    .filter((value): value is string => Boolean(value));
  const hasCompleteDecisiveTimestamps = Boolean(mergeAt && latestApprovalAt)
    && checkEvidence.decisiveTimestamps.length === checks.total;
  const freshnessReferenceAt = hasCompleteDecisiveTimestamps
    ? decisiveTimestamps.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    : null;
  const rawLatestAgeHours = (generatedAtEpoch - Date.parse(latestAt)) / 3_600_000;
  const rawAgeHours = freshnessReferenceAt
    ? (generatedAtEpoch - Date.parse(freshnessReferenceAt)) / 3_600_000
    : rawLatestAgeHours;
  const ageHours = Math.max(0, rawAgeHours);

  let continuity: PublicPrContinuity = "HOLD";
  const reasonCodes: string[] = [];
  let summary = "The public evidence is incomplete or does not establish a current merged approval.";
  let nextAction = "Resolve the missing or non-passing evidence and obtain repository-owned approval before a protected action.";
  if (rawLatestAgeHours < 0 || rawAgeHours < 0) {
    reasonCodes.push("evidence-after-observation-time");
    summary = "The selected observation time predates evidence returned by GitHub.";
    nextAction = "Use a current observation time and regenerate the receipt.";
  } else if (pullState === "closed" && !merged && approvals > 0) {
    continuity = "REVOKED";
    reasonCodes.push("approved-then-closed-unmerged");
    summary = "A formal approval exists, but the repository later closed the pull request without merging it.";
    nextAction = "Do not rely on the earlier approval; obtain a new repository-owned authorization for any successor change.";
  } else if (merged && approvals > 0 && changesRequested === 0 && checks.total > 0 && checks.failing === 0 && checks.pending === 0 && checks.unknown === 0 && snapshot.unavailable.length === 0 && freshnessReferenceAt) {
    if (ageHours > options.maxAgeHours) {
      continuity = "EXPIRED";
      reasonCodes.push("evidence-older-than-policy-window");
      summary = "The merge, approval, and checks were observed, but the evidence is older than the selected freshness window.";
      nextAction = "Refresh the public observation before using it in a current decision.";
    } else {
      continuity = "CURRENT";
      reasonCodes.push("merged-approved-checks-observed");
      summary = "The public record currently shows a merge, formal approval, and completed non-failing checks.";
      nextAction = "Bind this receipt to a repository-owned policy before using it for any protected action.";
    }
  } else {
    if (!merged) reasonCodes.push(pullState === "open" ? "pull-request-not-merged" : "closed-without-current-approval");
    if (merged && !mergeAt) reasonCodes.push("merge-timestamp-missing");
    if (!approvals) reasonCodes.push("formal-approval-missing");
    if (approvals && !latestApprovalAt) reasonCodes.push("approval-timestamp-missing");
    if (changesRequested) reasonCodes.push("changes-requested");
    if (!checks.total) reasonCodes.push("check-evidence-missing");
    if (checks.failing) reasonCodes.push("checks-failing");
    if (checks.pending) reasonCodes.push("checks-pending");
    if (checks.unknown) reasonCodes.push("check-conclusion-unknown");
    if (checks.passing && checkEvidence.decisiveTimestamps.length !== checks.passing) reasonCodes.push("check-timestamp-missing");
    if (snapshot.unavailable.length) reasonCodes.push("source-coverage-incomplete");
  }

  return {
    schemaVersion: PUBLIC_PR_RECEIPT_SCHEMA,
    generatedAt: options.generatedAt,
    tool: { name: "@sulmusic/agent-vigil", version: options.toolVersion, commit: options.toolCommit },
    subject: { url: target.url, repository: `${target.owner}/${target.repo}`, number: target.number, baseSha, headSha },
    observation: {
      pullRequestState: pullState,
      merged,
      approvals,
      changesRequested,
      checks,
      latestEvidenceAt: latestAt,
      freshnessReferenceAt,
      ageHours,
      maxAgeHours: options.maxAgeHours,
    },
    decision: { continuity, allowsProtectedAction: false, reasonCodes: [...new Set(reasonCodes)].sort(), summary, nextAction },
    claimBoundary: {
      executionObserved: true,
      sufficiencyAssessed: false,
      statement: PUBLIC_CLAIM_STATEMENT,
    },
    privacy: {
      publicMetadataOnly: true,
      sourceCodeFetched: false,
      sourceCodeRetained: false,
      promptsFetched: false,
      promptsRetained: false,
      transcriptsFetched: false,
      transcriptsRetained: false,
      requestBodiesSent: false,
    },
    integration: {
      mode: "read-only-public-github-api",
      repositoryWritePermission: false,
      workflowChangeRequired: false,
      secretRetention: false,
    },
    evidence: { sources: snapshot.sources, unavailable: [...snapshot.unavailable].sort() },
  };
}

export function validatePublicPrReceipt(value: unknown): PublicPrReceipt {
  const receipt = object(value, "public PR receipt");
  exactKeys(receipt, [
    "schemaVersion", "generatedAt", "tool", "subject", "observation", "decision",
    "claimBoundary", "privacy", "integration", "evidence", "receiptHash",
  ], ["signature"], "public PR receipt");
  if (receipt.schemaVersion !== PUBLIC_PR_RECEIPT_SCHEMA) throw new Error(`public PR receipt must use ${PUBLIC_PR_RECEIPT_SCHEMA}`);
  const generatedAt = canonicalTimestamp(receipt.generatedAt, "public PR receipt generatedAt");

  const tool = object(receipt.tool, "public PR receipt tool");
  exactKeys(tool, ["name", "version", "commit"], [], "public PR receipt tool");
  if (tool.name !== "@sulmusic/agent-vigil") throw new Error("public PR receipt tool name is invalid");
  boundedString(tool.version, "public PR receipt tool version", 64, /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);
  const toolCommit = boundedString(tool.commit, "public PR receipt tool commit", 64);
  validateToolCommit(toolCommit);

  const subject = object(receipt.subject, "public PR receipt subject");
  exactKeys(subject, ["url", "repository", "number", "baseSha", "headSha"], [], "public PR receipt subject");
  const target = parsePublicPullRequestUrl(boundedString(subject.url, "public PR receipt subject URL", 2048));
  if (subject.url !== target.url || subject.repository !== `${target.owner}/${target.repo}` || subject.number !== target.number) {
    throw new Error("public PR receipt subject fields do not identify the same pull request");
  }
  for (const [label, sha] of [["baseSha", subject.baseSha], ["headSha", subject.headSha]] as const) {
    if (typeof sha !== "string" || !FULL_GIT_SHA.test(sha)) throw new Error(`public PR receipt subject ${label} is invalid`);
  }

  const observation = object(receipt.observation, "public PR receipt observation");
  exactKeys(observation, [
    "pullRequestState", "merged", "approvals", "changesRequested", "checks", "latestEvidenceAt",
    "freshnessReferenceAt", "ageHours", "maxAgeHours",
  ], [], "public PR receipt observation");
  if (observation.pullRequestState !== "open" && observation.pullRequestState !== "closed") throw new Error("public PR receipt pull request state is invalid");
  const merged = booleanValue(observation.merged, "public PR receipt merged flag");
  if (observation.pullRequestState === "open" && merged) throw new Error("an open public PR receipt cannot be merged");
  const approvals = boundedInteger(observation.approvals, "public PR receipt approvals", 1_000_000);
  const changesRequested = boundedInteger(observation.changesRequested, "public PR receipt changesRequested", 1_000_000);
  const checks = object(observation.checks, "public PR receipt checks");
  exactKeys(checks, ["total", "passing", "failing", "pending", "unknown"], [], "public PR receipt checks");
  const total = boundedInteger(checks.total, "public PR receipt checks.total", 1_000_000);
  const passing = boundedInteger(checks.passing, "public PR receipt checks.passing", 1_000_000);
  const failing = boundedInteger(checks.failing, "public PR receipt checks.failing", 1_000_000);
  const pending = boundedInteger(checks.pending, "public PR receipt checks.pending", 1_000_000);
  const unknown = boundedInteger(checks.unknown, "public PR receipt checks.unknown", 1_000_000);
  if (total !== passing + failing + pending + unknown) throw new Error("public PR receipt check counts do not add up");
  const latestEvidenceAt = canonicalTimestamp(observation.latestEvidenceAt, "public PR receipt latestEvidenceAt");
  let freshnessReferenceAt: string | null;
  if (observation.freshnessReferenceAt === null) freshnessReferenceAt = null;
  else {
    freshnessReferenceAt = canonicalTimestamp(observation.freshnessReferenceAt, "public PR receipt freshnessReferenceAt");
    if (Date.parse(freshnessReferenceAt) > Date.parse(latestEvidenceAt)) throw new Error("public PR receipt freshness reference cannot be newer than its latest evidence");
  }
  const ageHours = boundedNumber(observation.ageHours, "public PR receipt ageHours", 1_000_000_000);
  const ageReferenceAt = freshnessReferenceAt ?? latestEvidenceAt;
  const expectedAge = Math.max(0, (Date.parse(generatedAt) - Date.parse(ageReferenceAt)) / 3_600_000);
  if (ageHours !== expectedAge) throw new Error("public PR receipt ageHours does not match its freshness reference");
  const maxAgeHours = boundedNumber(observation.maxAgeHours, "public PR receipt maxAgeHours", 24 * 365);
  if (maxAgeHours <= 0) throw new Error("public PR receipt maxAgeHours must be greater than zero");

  const decision = object(receipt.decision, "public PR receipt decision");
  exactKeys(decision, ["continuity", "allowsProtectedAction", "reasonCodes", "summary", "nextAction"], [], "public PR receipt decision");
  if (!(["CURRENT", "HOLD", "EXPIRED", "REVOKED"] as unknown[]).includes(decision.continuity)) throw new Error("public PR receipt continuity is invalid");
  if (decision.allowsProtectedAction !== false) throw new Error("a public PR receipt must not authorize a protected action");
  if (!Array.isArray(decision.reasonCodes) || decision.reasonCodes.length > 32) throw new Error("public PR receipt reasonCodes must be an array of at most 32 entries");
  const reasonCodes = decision.reasonCodes.map((item, index) => boundedString(item, `public PR receipt reasonCodes[${index}]`, 80, /^[a-z0-9][a-z0-9-]*$/));
  if (new Set(reasonCodes).size !== reasonCodes.length || reasonCodes.some((item, index) => item !== [...reasonCodes].sort()[index])) {
    throw new Error("public PR receipt reasonCodes must be unique and sorted");
  }
  boundedString(decision.summary, "public PR receipt summary", 1024);
  boundedString(decision.nextAction, "public PR receipt nextAction", 1024);

  const claimBoundary = object(receipt.claimBoundary, "public PR receipt claimBoundary");
  exactKeys(claimBoundary, ["executionObserved", "sufficiencyAssessed", "statement"], [], "public PR receipt claimBoundary");
  if (claimBoundary.executionObserved !== true || claimBoundary.sufficiencyAssessed !== false || claimBoundary.statement !== PUBLIC_CLAIM_STATEMENT) {
    throw new Error("public PR receipt claim boundary is invalid");
  }

  const privacy = object(receipt.privacy, "public PR receipt privacy");
  exactKeys(privacy, [
    "publicMetadataOnly", "sourceCodeFetched", "sourceCodeRetained", "promptsFetched", "promptsRetained",
    "transcriptsFetched", "transcriptsRetained", "requestBodiesSent",
  ], [], "public PR receipt privacy");
  if (privacy.publicMetadataOnly !== true || privacy.sourceCodeFetched !== false || privacy.sourceCodeRetained !== false
    || privacy.promptsFetched !== false || privacy.promptsRetained !== false || privacy.transcriptsFetched !== false
    || privacy.transcriptsRetained !== false || privacy.requestBodiesSent !== false) {
    throw new Error("public PR receipt privacy boundary is invalid");
  }

  const integration = object(receipt.integration, "public PR receipt integration");
  exactKeys(integration, ["mode", "repositoryWritePermission", "workflowChangeRequired", "secretRetention"], [], "public PR receipt integration");
  if (integration.mode !== "read-only-public-github-api" || integration.repositoryWritePermission !== false
    || integration.workflowChangeRequired !== false || integration.secretRetention !== false) {
    throw new Error("public PR receipt integration boundary is invalid");
  }

  const evidence = object(receipt.evidence, "public PR receipt evidence");
  exactKeys(evidence, ["sources", "unavailable"], [], "public PR receipt evidence");
  if (!Array.isArray(evidence.sources) || evidence.sources.length > 4) throw new Error("public PR receipt sources must be an array of at most four entries");
  const expectedEndpoints: Record<PublicPrSource["kind"], string> = {
    "pull-request": `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.number}`,
    reviews: `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.number}/reviews?per_page=100`,
    "check-runs": `https://api.github.com/repos/${target.owner}/${target.repo}/commits/${subject.headSha}/check-runs?per_page=100`,
    "commit-statuses": `https://api.github.com/repos/${target.owner}/${target.repo}/commits/${subject.headSha}/statuses?per_page=100`,
  };
  const sourceKinds: string[] = [];
  for (const [index, sourceValue] of evidence.sources.entries()) {
    const selected = object(sourceValue, `public PR receipt sources[${index}]`);
    exactKeys(selected, ["kind", "endpoint", "status", "bytes", "sha256", "complete"], [], `public PR receipt sources[${index}]`);
    if (typeof selected.kind !== "string" || !Object.prototype.hasOwnProperty.call(expectedEndpoints, selected.kind)) {
      throw new Error(`public PR receipt sources[${index}].kind is invalid`);
    }
    const kind = selected.kind as PublicPrSource["kind"];
    sourceKinds.push(kind);
    if (selected.endpoint !== expectedEndpoints[kind]) throw new Error(`public PR receipt sources[${index}].endpoint is invalid`);
    boundedInteger(selected.status, `public PR receipt sources[${index}].status`, 599);
    if (Number(selected.status) < 100) throw new Error(`public PR receipt sources[${index}].status is invalid`);
    boundedInteger(selected.bytes, `public PR receipt sources[${index}].bytes`, MAX_GITHUB_RESPONSE_BYTES);
    if (typeof selected.sha256 !== "string" || !SHA256_IDENTIFIER.test(selected.sha256)) throw new Error(`public PR receipt sources[${index}].sha256 is invalid`);
    booleanValue(selected.complete, `public PR receipt sources[${index}].complete`);
  }
  if (new Set(sourceKinds).size !== sourceKinds.length) throw new Error("public PR receipt source kinds must be unique");
  if (!Array.isArray(evidence.unavailable) || evidence.unavailable.length > 16) throw new Error("public PR receipt unavailable evidence must be an array of at most 16 entries");
  const unavailable = evidence.unavailable.map((item, index) => boundedString(
    item,
    `public PR receipt unavailable[${index}]`,
    80,
    /^(?:reviews|check-runs|commit-statuses):(?:network-error|http-[1-5][0-9]{2}|pagination-incomplete|invalid-response)$/,
  ));
  if (new Set(unavailable).size !== unavailable.length || unavailable.some((item, index) => item !== [...unavailable].sort()[index])) {
    throw new Error("public PR receipt unavailable evidence must be unique and sorted");
  }

  if (decision.continuity === "CURRENT" || decision.continuity === "EXPIRED") {
    if (observation.pullRequestState !== "closed" || !merged || approvals < 1 || changesRequested !== 0 || total < 1
      || failing !== 0 || pending !== 0 || unknown !== 0 || unavailable.length !== 0
      || freshnessReferenceAt === null || Date.parse(freshnessReferenceAt) > Date.parse(generatedAt)
      || sourceKinds.length !== 4 || evidence.sources.some((item) => {
        const selected = item as Record<string, unknown>;
        return selected.status !== 200 || selected.complete !== true;
      })) {
      throw new Error("public PR receipt current/expired decision contradicts its evidence summary");
    }
    if (decision.continuity === "CURRENT" && ageHours > maxAgeHours) {
      throw new Error("public PR receipt CURRENT decision exceeds its freshness policy");
    }
    if (decision.continuity === "EXPIRED" && ageHours <= maxAgeHours) {
      throw new Error("public PR receipt EXPIRED decision is within its freshness policy");
    }
  }
  if (decision.continuity === "REVOKED" && (observation.pullRequestState !== "closed" || merged || approvals < 1)) {
    throw new Error("public PR receipt revoked decision contradicts its evidence summary");
  }

  if (typeof receipt.receiptHash !== "string" || !SHA256_IDENTIFIER.test(receipt.receiptHash)) throw new Error("public PR receipt hash is invalid");
  if (receipt.signature !== undefined) {
    const signature = object(receipt.signature, "public PR receipt signature");
    exactKeys(signature, ["algorithm", "keyId", "publicKey", "value"], [], "public PR receipt signature");
    if (signature.algorithm !== "Ed25519") throw new Error("public PR receipt signature algorithm is invalid");
    if (typeof signature.keyId !== "string" || !SHA256_IDENTIFIER.test(signature.keyId)) throw new Error("public PR receipt signature keyId is invalid");
    canonicalBase64(signature.publicKey, "public PR receipt signature publicKey", 2048);
    canonicalBase64(signature.value, "public PR receipt signature value", 2048);
  }
  return value as PublicPrReceipt;
}

export function buildPublicPrReceipt(snapshot: PublicPrSnapshot, rawUrl: string, options: BuildPublicPrReceiptOptions): PublicPrReceipt {
  const unsigned = unsignedReceipt(snapshot, rawUrl, options);
  return validatePublicPrReceipt({ ...unsigned, receiptHash: sha256(canonical(unsigned)) });
}

export function signPublicPrReceipt(receipt: PublicPrReceipt, privateKeyPath: string): PublicPrReceipt {
  const selectedReceipt = validatePublicPrReceipt(receipt);
  if (recomputePublicPrReceiptHash(selectedReceipt) !== selectedReceipt.receiptHash) throw new Error("refusing to sign a public PR receipt with an invalid content hash");
  const privateKey = createPrivateKey(readBoundedRegularFile(privateKeyPath, MAX_SIGNING_KEY_BYTES, "public PR receipt signing key"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  return {
    ...selectedReceipt,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(selectedReceipt.receiptHash), privateKey).toString("base64"),
    },
  };
}

export function recomputePublicPrReceiptHash(receipt: PublicPrReceipt): string {
  const { receiptHash: _receiptHash, signature: _signature, ...unsigned } = receipt;
  return sha256(canonical(unsigned));
}

export function verifyPublicPrReceipt(receipt: PublicPrReceipt): { hashValid: boolean; signatureValid?: boolean; keyId?: string } {
  let selectedReceipt: PublicPrReceipt;
  try { selectedReceipt = validatePublicPrReceipt(receipt); }
  catch { return { hashValid: false }; }
  const hashValid = recomputePublicPrReceiptHash(selectedReceipt) === selectedReceipt.receiptHash;
  if (!selectedReceipt.signature) return { hashValid };
  try {
    const publicKey = createPublicKey({ key: Buffer.from(selectedReceipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    const keyId = signingKeyId(publicKeyDer(publicKey));
    const signatureValid = keyId === selectedReceipt.signature.keyId
      && verify(null, Buffer.from(selectedReceipt.receiptHash), publicKey, Buffer.from(selectedReceipt.signature.value, "base64"));
    return { hashValid, signatureValid, keyId };
  } catch {
    return { hashValid, signatureValid: false };
  }
}

export function renderPublicPrReceipt(receipt: PublicPrReceipt): string {
  const checks = receipt.observation.checks;
  return [
    "Agent Vigil public PR receipt",
    "",
    `${receipt.decision.continuity} — ${receipt.decision.summary}`,
    `PR: ${receipt.subject.url}`,
    `Observed: ${receipt.generatedAt}`,
    `Tool pin: ${receipt.tool.commit}`,
    `Approval: ${receipt.observation.approvals} approved · ${receipt.observation.changesRequested} changes requested`,
    `Checks: ${checks.passing} passing · ${checks.failing} failing · ${checks.pending} pending · ${checks.unknown} unknown`,
    `Protected action: NOT AUTHORIZED`,
    `Receipt: ${receipt.receiptHash}`,
    `Signature: ${receipt.signature ? receipt.signature.keyId : "UNSIGNED"}`,
    "",
    `What this proves: ${receipt.claimBoundary.statement}`,
    `Next: ${receipt.decision.nextAction}`,
    "",
  ].join("\n");
}

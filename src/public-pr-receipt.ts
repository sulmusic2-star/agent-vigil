import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical } from "./report.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";

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
    ageHours: number;
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
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024 * 1024;
const SUCCESSFUL_CHECKS = new Set(["success", "neutral", "skipped"]);
const FAILED_CHECKS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);

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

export async function defaultPublicPrTransport(url: string, headers: Record<string, string>): Promise<PublicPrTransportResponse> {
  const response = await fetch(url, { method: "GET", headers, redirect: "error" });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub metadata response exceeds the 16 MiB limit");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub metadata response exceeds the 16 MiB limit");
  const selected: Record<string, string | undefined> = {
    link: response.headers.get("link") ?? undefined,
    "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") ?? undefined,
  };
  return { status: response.status, headers: selected, body };
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
  const head = object(pull.head, "GitHub pull request head");
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
    if (!login || !submittedAt) continue;
    const previous = latest.get(login);
    if (!previous || Date.parse(submittedAt) >= Date.parse(timestamp(previous.submitted_at) ?? "1970-01-01T00:00:00.000Z")) latest.set(login, review);
  }
  return [...latest.values()];
}

function checkSummary(checkRuns: unknown[], statuses: unknown[]): PublicPrReceipt["observation"]["checks"] {
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
  for (const check of latestRuns.values()) {
    if (lower(check.status) !== "completed") { pending += 1; continue; }
    const conclusion = lower(check.conclusion);
    if (SUCCESSFUL_CHECKS.has(conclusion)) passing += 1;
    else if (FAILED_CHECKS.has(conclusion)) failing += 1;
    else unknown += 1;
  }
  for (const status of latestStatuses.values()) {
    const state = lower(status.state);
    if (state === "success") passing += 1;
    else if (state === "pending") pending += 1;
    else if (FAILED_CHECKS.has(state)) failing += 1;
    else unknown += 1;
  }
  return { total: passing + failing + pending + unknown, passing, failing, pending, unknown };
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
  const base = object(pull.base, "GitHub pull request base");
  const head = object(pull.head, "GitHub pull request head");
  const baseSha = string(base.sha);
  const headSha = string(head.sha);
  if (!baseSha || !FULL_GIT_SHA.test(baseSha) || !headSha || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub pull request response must contain full base and head SHAs");
  const pullState = lower(pull.state);
  if (pullState !== "open" && pullState !== "closed") throw new Error("GitHub pull request state is unsupported");
  const merged = Boolean(pull.merged_at ?? pull.merged);
  const reviews = latestReviews(snapshot.reviews);
  const approvals = reviews.filter((review) => lower(review.state) === "approved").length;
  const changesRequested = reviews.filter((review) => lower(review.state) === "changes_requested").length;
  const checks = checkSummary(snapshot.checkRuns, snapshot.statuses);
  const latestAt = latestEvidenceAt(snapshot);
  const rawAgeHours = (generatedAtEpoch - Date.parse(latestAt)) / 3_600_000;
  const ageHours = Math.max(0, rawAgeHours);

  let continuity: PublicPrContinuity = "HOLD";
  const reasonCodes: string[] = [];
  let summary = "The public evidence is incomplete or does not establish a current merged approval.";
  let nextAction = "Resolve the missing or non-passing evidence and obtain repository-owned approval before a protected action.";
  if (rawAgeHours < 0) {
    reasonCodes.push("evidence-after-observation-time");
    summary = "The selected observation time predates evidence returned by GitHub.";
    nextAction = "Use a current observation time and regenerate the receipt.";
  } else if (pullState === "closed" && !merged && approvals > 0) {
    continuity = "REVOKED";
    reasonCodes.push("approved-then-closed-unmerged");
    summary = "A formal approval exists, but the repository later closed the pull request without merging it.";
    nextAction = "Do not rely on the earlier approval; obtain a new repository-owned authorization for any successor change.";
  } else if (merged && approvals > 0 && changesRequested === 0 && checks.total > 0 && checks.failing === 0 && checks.pending === 0 && checks.unknown === 0 && snapshot.unavailable.length === 0) {
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
    if (!approvals) reasonCodes.push("formal-approval-missing");
    if (changesRequested) reasonCodes.push("changes-requested");
    if (!checks.total) reasonCodes.push("check-evidence-missing");
    if (checks.failing) reasonCodes.push("checks-failing");
    if (checks.pending) reasonCodes.push("checks-pending");
    if (checks.unknown) reasonCodes.push("check-conclusion-unknown");
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
      ageHours: Number(ageHours.toFixed(3)),
    },
    decision: { continuity, allowsProtectedAction: false, reasonCodes: [...new Set(reasonCodes)].sort(), summary, nextAction },
    claimBoundary: {
      executionObserved: true,
      sufficiencyAssessed: false,
      statement: "This receipt attests that selected public GitHub events and checks were observed. It does not establish that the checks were sufficient, that the change is safe, or that deployment is authorized.",
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

export function buildPublicPrReceipt(snapshot: PublicPrSnapshot, rawUrl: string, options: BuildPublicPrReceiptOptions): PublicPrReceipt {
  const unsigned = unsignedReceipt(snapshot, rawUrl, options);
  return { ...unsigned, receiptHash: sha256(canonical(unsigned)) };
}

export function signPublicPrReceipt(receipt: PublicPrReceipt, privateKeyPath: string): PublicPrReceipt {
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  return {
    ...receipt,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(receipt.receiptHash), privateKey).toString("base64"),
    },
  };
}

export function recomputePublicPrReceiptHash(receipt: PublicPrReceipt): string {
  const { receiptHash: _receiptHash, signature: _signature, ...unsigned } = receipt;
  return sha256(canonical(unsigned));
}

export function verifyPublicPrReceipt(receipt: PublicPrReceipt): { hashValid: boolean; signatureValid?: boolean; keyId?: string } {
  const hashValid = recomputePublicPrReceiptHash(receipt) === receipt.receiptHash;
  if (!receipt.signature) return { hashValid };
  if (receipt.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false };
  try {
    const publicKey = createPublicKey({ key: Buffer.from(receipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    const keyId = signingKeyId(publicKeyDer(publicKey));
    const signatureValid = keyId === receipt.signature.keyId
      && verify(null, Buffer.from(receipt.receiptHash), publicKey, Buffer.from(receipt.signature.value, "base64"));
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

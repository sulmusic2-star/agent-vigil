import { createPrivateKey, createPublicKey } from "node:crypto";
import { canonical } from "../report.ts";
import { publicKeyDer, signingKeyId } from "../signature.ts";
import { verifyWebhookSignature } from "../attestation.ts";
import { buildGitHubWebhookEvidence } from "../github-evidence.ts";
import { appendContinuityEvent, verifyContinuityChain } from "./chain.ts";
import {
  canonicalSha256,
  readBoundedRegularFile,
  sha256,
  validateEventDraft,
  type ContinuityEvent,
  type ContinuityEventDraft,
  type ContinuityEventKind,
  type ContinuityRoot,
} from "./contracts.ts";

const MAX_GITHUB_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type GitHubImportReceipt = {
  schemaVersion: "agent-vigil-github-import/v1";
  appended: boolean;
  eventId: string;
  sequence: number;
  kind: ContinuityEventKind;
  disposition: ContinuityEventDraft["event"]["disposition"];
  eventHash: string;
  evidenceHash: string;
  deliveryIdHash: string;
};

type ImportOptions = {
  chain: string;
  deliveryId: string;
  eventPath?: string;
  webhookSignature?: string;
  webhookSecretPath?: string;
  unavailable?: boolean;
  observedAt?: string;
  signingKeyPath?: string;
};

type Outcome = {
  kind: ContinuityEventKind;
  disposition: ContinuityEventDraft["event"]["disposition"];
  reasonCode: string;
  effectiveAt: string;
  targetHash: string;
};

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return value;
}

function normalizeDeliveryId(value: string): string {
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) throw new Error("--delivery-id must be a canonical UUID");
  return normalized;
}

export function githubRepositoryFromRemote(remote: unknown): string {
  if (typeof remote !== "string" || !remote.trim()) throw new Error("the original receipt does not name a GitHub repository");
  const selected = remote.trim().replace(/^git\+/, "");
  let match = selected.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
    ?? selected.match(/^(?:https?|ssh):\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
    ?? selected.match(/^github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error("the original receipt does not name a supported GitHub repository remote");
  const repository = match[1].replace(/\.git$/i, "");
  if (!REPOSITORY.test(repository)) throw new Error("the original receipt has an invalid GitHub repository name");
  return repository.toLowerCase();
}

function labels(value: any): string[] {
  if (!Array.isArray(value?.labels) || value.labels.length > 100) return [];
  return value.labels
    .map((label: any) => typeof label === "string" ? label : label?.name)
    .filter((label: unknown): label is string => typeof label === "string" && label.length <= 100);
}

function linked(labelsValue: string[], head: string): boolean {
  const wanted = `agent-vigil:${head}`;
  return labelsValue.some((label) => label.toLowerCase() === wanted);
}

function target(kind: string, repository: string, identifier: string): string {
  return sha256(`agent-vigil-github-target/v1\0${kind}\0${repository}\0${identifier}`);
}

function classify(payload: any, root: ContinuityRoot, repository: string): Outcome {
  const payloadRepository = payload?.repository?.full_name;
  if (typeof payloadRepository !== "string" || payloadRepository.toLowerCase() !== repository) {
    throw new Error("GitHub evidence belongs to a different repository");
  }

  const pull = payload?.pull_request;
  if (pull && typeof pull === "object") {
    if (payload.action !== "closed" || pull.state !== "closed" || pull.merged !== true
      || !Number.isSafeInteger(pull.number) || pull.number <= 0) {
      throw new Error("GitHub pull-request evidence must describe a completed merge");
    }
    const mergeSha = fullSha(pull.merge_commit_sha, "GitHub merge commit");
    const pullLabels = labels(pull);
    const hotfix = pullLabels.some((label) => /^(?:hotfix|emergency[- ]fix)$/i.test(label));
    if (hotfix) {
      if (!linked(pullLabels, root.subject.headSha)) throw new Error("hotfix evidence must carry the exact Agent Vigil head link label");
      return {
        kind: "hotfix_observed",
        disposition: "observe",
        reasonCode: "github.hotfix.linked",
        effectiveAt: canonicalTimestamp(pull.merged_at, "GitHub hotfix merge time"),
        targetHash: target("hotfix", repository, mergeSha),
      };
    }
    if (fullSha(pull.base?.sha, "GitHub pull-request base") !== root.subject.baseSha
      || fullSha(pull.head?.sha, "GitHub pull-request head") !== root.subject.headSha) {
      throw new Error("GitHub merge evidence does not match the original base and head commits");
    }
    return {
      kind: "merge_observed",
      disposition: "affirm",
      reasonCode: "github.merge.verified",
      effectiveAt: canonicalTimestamp(pull.merged_at, "GitHub merge time"),
      targetHash: target("merge", repository, mergeSha),
    };
  }

  const issue = payload?.issue;
  if (issue && typeof issue === "object" && !issue.pull_request) {
    if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || !new Set(["open", "closed"]).has(issue.state)) {
      throw new Error("GitHub incident evidence must describe an open or closed numbered issue");
    }
    const issueLabels = labels(issue);
    if (!issueLabels.some((label) => /^(?:incident|outage|sev[- ]?[0-9]+)$/i.test(label))) {
      throw new Error("GitHub issue evidence must carry an incident, outage, or severity label");
    }
    if (!linked(issueLabels, root.subject.headSha)) throw new Error("incident evidence must carry the exact Agent Vigil head link label");
    const issueId = Number.isSafeInteger(issue.id) && issue.id > 0 ? String(issue.id) : undefined;
    if (!issueId) throw new Error("GitHub incident evidence must include a numeric issue ID");
    return {
      kind: "incident_linked",
      disposition: "observe",
      reasonCode: "github.incident.linked",
      effectiveAt: canonicalTimestamp(issue.updated_at ?? issue.created_at, "GitHub incident time"),
      targetHash: target("incident", repository, issueId),
    };
  }

  if (Array.isArray(payload?.commits)) {
    if (payload.commits.length > 2_048) throw new Error("GitHub push evidence contains too many commits");
    const after = fullSha(payload.after, "GitHub push head");
    const revert = payload.commits.find((commit: any) => {
      const id = typeof commit?.id === "string" ? commit.id : "";
      const message = typeof commit?.message === "string" ? commit.message : "";
      return GIT_SHA.test(id) && new RegExp(`(?:This reverts commit|reverts?)[ :]+${root.subject.headSha}(?:\\b|$)`, "i").test(message);
    });
    if (!revert) throw new Error("GitHub push evidence does not contain an exact revert link to the original head commit");
    return {
      kind: "revert_observed",
      disposition: "revoke",
      reasonCode: "github.revert.linked",
      effectiveAt: canonicalTimestamp(revert.timestamp ?? payload.head_commit?.timestamp, "GitHub revert time"),
      targetHash: target("revert", repository, after),
    };
  }

  throw new Error("GitHub evidence is not a supported merge, revert, hotfix, or linked incident event");
}

function readSecret(path: string): string {
  const raw = readBoundedRegularFile(path, MAX_SECRET_BYTES, "GitHub webhook secret").toString("utf8");
  const secret = raw.replace(/\r?\n$/, "");
  if (!secret || secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("GitHub webhook secret is empty or invalid");
  }
  return secret;
}

function signingIssuer(path: string): string {
  const key = createPrivateKey(readBoundedRegularFile(path, 64 * 1024, "continuity signing key"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("continuity signing key must be Ed25519");
  return signingKeyId(publicKeyDer(createPublicKey(key)));
}

function publicReceipt(event: ContinuityEvent, appended: boolean): GitHubImportReceipt {
  return {
    schemaVersion: "agent-vigil-github-import/v1",
    appended,
    eventId: event.eventId,
    sequence: event.sequence,
    kind: event.event.kind,
    disposition: event.event.disposition,
    eventHash: event.eventHash,
    evidenceHash: event.source.evidenceHash,
    deliveryIdHash: event.source.deliveryIdHash!,
  };
}

function storedDraft(event: ContinuityEvent): ContinuityEventDraft {
  const { sequence: _sequence, predecessorHash: _predecessor, eventHash: _hash, signature: _signature, ...draft } = event;
  return draft;
}

function appendIdempotently(
  chain: string,
  draft: ContinuityEventDraft,
  signingKeyPath?: string,
): GitHubImportReceipt {
  const verified = verifyContinuityChain(chain);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const existing = verified.events.find((event) => event.source.deliveryIdHash === draft.source.deliveryIdHash);
  if (existing) {
    const signatureMatches = signingKeyPath ? existing.signature?.keyId === draft.source.issuer : existing.signature === null;
    if (canonical(storedDraft(existing)) !== canonical(draft) || !signatureMatches) {
      throw new Error("the GitHub delivery ID was already recorded with different evidence");
    }
    return publicReceipt(existing, false);
  }
  return publicReceipt(appendContinuityEvent(chain, draft, signingKeyPath), true);
}

export function importGitHubOutcome(options: ImportOptions): GitHubImportReceipt {
  const deliveryId = normalizeDeliveryId(options.deliveryId);
  const deliveryIdHash = sha256(`agent-vigil-github-delivery/v1\0${deliveryId}`);
  const verified = verifyContinuityChain(options.chain);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const signingKeyPath = options.signingKeyPath;

  if (options.unavailable) {
    if (options.eventPath || options.webhookSignature || options.webhookSecretPath) {
      throw new Error("--unavailable cannot be combined with webhook evidence options");
    }
    if (!signingKeyPath) throw new Error("--unavailable requires --signing-key so the local outage record has an accountable issuer");
    const observedAt = canonicalTimestamp(options.observedAt, "--observed-at");
    const draft = validateEventDraft({
      schemaVersion: "agent-vigil-continuity-event/v1",
      eventId: `urn:uuid:${deliveryId}`,
      subject: verified.root.subject,
      source: {
        kind: "github-outcome",
        issuer: signingIssuer(signingKeyPath),
        evidenceHash: canonicalSha256({ schemaVersion: "agent-vigil-github-outage/v1", deliveryIdHash, observedAt }),
        deliveryIdHash,
      },
      event: {
        kind: "coverage_gap",
        disposition: "hold",
        reasonCode: "github.adapter.unavailable",
        targetHash: null,
        freshUntil: null,
        supersedesEventId: null,
      },
      observedAt,
      effectiveAt: observedAt,
      privacyTier: "receipt",
    });
    return appendIdempotently(options.chain, draft, signingKeyPath);
  }

  if (!options.eventPath || !options.webhookSecretPath || !options.webhookSignature) {
    throw new Error("GitHub import requires --event, --webhook-secret-file, and --webhook-signature");
  }
  if (options.observedAt) throw new Error("--observed-at is valid only with --unavailable");
  if (!SIGNATURE.test(options.webhookSignature)) throw new Error("--webhook-signature must be a lowercase SHA-256 GitHub signature");
  const raw = readBoundedRegularFile(options.eventPath, MAX_GITHUB_EVENT_BYTES, "GitHub event evidence");
  const secret = readSecret(options.webhookSecretPath);
  if (!verifyWebhookSignature(secret, raw, options.webhookSignature)) throw new Error("GitHub webhook signature is invalid");
  let payload: any;
  try { payload = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("GitHub event evidence is not valid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("GitHub event evidence must be an object");
  const repository = githubRepositoryFromRemote(verified.report.repository.remote);
  const outcome = classify(payload, verified.root, repository);
  const evidence = buildGitHubWebhookEvidence(raw, new Date(outcome.effectiveAt));
  const issuer = signingKeyPath
    ? signingIssuer(signingKeyPath)
    : sha256("agent-vigil-github-authenticated-source/v1");
  const draft = validateEventDraft({
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:${deliveryId}`,
    subject: verified.root.subject,
    source: {
      kind: "github-outcome",
      issuer,
      evidenceHash: evidence.evidenceHash,
      deliveryIdHash,
    },
    event: {
      kind: outcome.kind,
      disposition: outcome.disposition,
      reasonCode: outcome.reasonCode,
      targetHash: outcome.targetHash,
      freshUntil: null,
      supersedesEventId: null,
    },
    observedAt: outcome.effectiveAt,
    effectiveAt: outcome.effectiveAt,
    privacyTier: "receipt",
  });
  return appendIdempotently(options.chain, draft, signingKeyPath);
}

const TOOL_VERSION = "0.22.0-browser.1";
const TOOL_COMMIT = "78751509c1be65d920e1dbb82d8eb45417452bb3";
const RELEASE_PACKAGE = "https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz";
const PUBLIC_CLAIM_STATEMENT = "This receipt attests that selected public GitHub events and checks were observed. It does not establish that the checks were sufficient, that the change is safe, or that deployment is authorized.";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RECEIPT_SHA256 = /^sha256:[0-9a-f]{64}$/;
const REASON_CODE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const REPOSITORY_PART = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const ADOPTION_FORM = "https://github.com/sulmusic2-star/agent-vigil/issues/new?template=adopter-feedback.yml";
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
// GitHub accepts neutral and skipped required checks. This evidence view does
// not call either conclusion a pass because no successful run was proved.
const SUCCESSFUL_CHECKS = new Set(["success"]);
const NON_PROVING_CHECKS = new Set(["neutral", "skipped"]);
const FAILED_CHECKS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);
const EFFECTIVE_REVIEW_STATES = new Set(["approved", "changes_requested", "dismissed"]);
export function parsePullRequestUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Enter a full public GitHub pull-request URL."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an uncredentialed https://github.com URL without query or fragment data.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) {
    throw new Error("The URL must match https://github.com/owner/repository/pull/123.");
  }
  const [owner, repo] = parts;
  const number = Number(parts[3]);
  if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("The pull-request owner, repository, or number is invalid.");
  }
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}
export function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot calculate a SHA-256 receipt hash.");
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object.`);
  return value;
}

function array(value) { return Array.isArray(value) ? value : []; }
function lower(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}
function integer(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function publicRepositorySides(pull) {
  const base = object(pull.base, "GitHub pull-request base");
  const head = object(pull.head, "GitHub pull-request head");
  const baseRepo = object(base.repo, "GitHub base repository");
  const headRepo = object(head.repo, "GitHub head repository");
  if (baseRepo.private !== false || headRepo.private !== false) throw new Error("Both sides of the pull request must be public.");
  return { base, head };
}
async function readResponse(response, kind, endpoint) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error(`${kind} metadata exceeds the 16 MiB limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`${kind} metadata exceeds the 16 MiB limit.`);
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${kind} metadata was not valid JSON.`); }
  return {
    value,
    source: {
      kind,
      endpoint,
      status: response.status,
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
      complete: !/rel="next"/.test(response.headers.get("link") ?? ""),
    },
  };
}

async function request(endpoint, kind, fetchImpl) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    return { response, ...(await readResponse(response, kind, endpoint)) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${kind} metadata exceeded the 30-second deadline.`);
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function collectPublicPullRequest(rawUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This browser does not provide fetch.");
  const target = parsePullRequestUrl(rawUrl);
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const pullEndpoint = `${root}/pulls/${target.number}`;
  const pullResult = await request(pullEndpoint, "pull-request", fetchImpl);
  if (pullResult.response.status !== 200) throw new Error(`GitHub returned HTTP ${pullResult.response.status} for that pull request.`);
  const pull = object(pullResult.value, "GitHub pull-request response");
  const { head } = publicRepositorySides(pull);
  const headSha = typeof head.sha === "string" ? head.sha : "";
  if (!FULL_GIT_SHA.test(headSha)) throw new Error("GitHub did not return a full pull-request head SHA.");

  const definitions = [
    { kind: "reviews", endpoint: `${root}/pulls/${target.number}/reviews?per_page=100`, select: array },
    { kind: "check-runs", endpoint: `${root}/commits/${headSha}/check-runs?per_page=100`, select: (value) => array(object(value, "GitHub check-runs response").check_runs) },
    { kind: "commit-statuses", endpoint: `${root}/commits/${headSha}/statuses?per_page=100`, select: array },
  ];
  const results = await Promise.all(definitions.map(async (definition) => {
    try { return { definition, result: await request(definition.endpoint, definition.kind, fetchImpl) }; }
    catch { return { definition, result: undefined }; }
  }));
  const sources = [pullResult.source];
  const unavailable = [];
  const values = new Map();
  for (const { definition, result } of results) {
    if (!result) {
      unavailable.push(`${definition.kind}:network-error`);
      values.set(definition.kind, []);
      continue;
    }
    sources.push(result.source);
    if (result.response.status !== 200) {
      unavailable.push(`${definition.kind}:http-${result.response.status}`);
      values.set(definition.kind, []);
      continue;
    }
    if (!result.source.complete) unavailable.push(`${definition.kind}:pagination-incomplete`);
    try { values.set(definition.kind, definition.select(result.value)); }
    catch { unavailable.push(`${definition.kind}:invalid-response`); values.set(definition.kind, []); }
  }
  return {
    target,
    pull,
    reviews: values.get("reviews") ?? [],
    checkRuns: values.get("check-runs") ?? [],
    statuses: values.get("commit-statuses") ?? [],
    sources,
    unavailable,
  };
}

function latestReviews(records) {
  const latest = new Map();
  for (const item of records) {
    const review = object(item, "GitHub review");
    const user = object(review.user, "GitHub review user");
    const login = lower(user.login);
    const submittedAt = timestamp(review.submitted_at);
    if (!login || !submittedAt || !EFFECTIVE_REVIEW_STATES.has(lower(review.state))) continue;
    const previous = latest.get(login);
    const previousAt = previous ? timestamp(previous.submitted_at) ?? "1970-01-01T00:00:00.000Z" : undefined;
    if (!previous || Date.parse(submittedAt) >= Date.parse(previousAt)) latest.set(login, review);
  }
  return [...latest.values()];
}

export function latestVisibleChecks(checkRuns, statuses) {
  const rows = new Map();
  for (const item of checkRuns) {
    const check = object(item, "GitHub check run");
    const app = check.app && typeof check.app === "object" && !Array.isArray(check.app) ? lower(check.app.slug) : "unknown-app";
    const name = typeof check.name === "string" && check.name.trim() ? check.name.trim() : `check ${integer(check.id) ?? rows.size + 1}`;
    const key = `run:${app}:${name.toLowerCase()}`;
    const at = timestamp(check.completed_at) ?? timestamp(check.started_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = rows.get(key);
    if (!previous || Date.parse(at) >= Date.parse(previous.at)) {
      const conclusion = lower(check.conclusion);
      const state = lower(check.status) !== "completed" ? "pending" : SUCCESSFUL_CHECKS.has(conclusion) ? "passing" : FAILED_CHECKS.has(conclusion) ? "failing" : "unknown";
      rows.set(key, { name, state, conclusion, at, url: typeof check.html_url === "string" ? check.html_url : undefined });
    }
  }
  for (const item of statuses) {
    const status = object(item, "GitHub commit status");
    const name = typeof status.context === "string" && status.context.trim() ? status.context.trim() : `status ${integer(status.id) ?? rows.size + 1}`;
    const key = `status:${name.toLowerCase()}`;
    const at = timestamp(status.updated_at) ?? timestamp(status.created_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = rows.get(key);
    if (!previous || Date.parse(at) >= Date.parse(previous.at)) {
      const rawState = lower(status.state);
      const state = rawState === "success" ? "passing" : rawState === "pending" ? "pending" : FAILED_CHECKS.has(rawState) ? "failing" : "unknown";
      rows.set(key, { name, state, conclusion: rawState, at, url: typeof status.target_url === "string" ? status.target_url : undefined });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function latestEvidenceAt(snapshot) {
  const candidates = [];
  for (const value of [snapshot.pull.updated_at, snapshot.pull.closed_at, snapshot.pull.merged_at]) {
    const selected = timestamp(value); if (selected) candidates.push(selected);
  }
  for (const value of [...snapshot.reviews, ...snapshot.checkRuns, ...snapshot.statuses]) {
    const record = object(value, "GitHub evidence record");
    for (const candidate of [record.submitted_at, record.completed_at, record.updated_at, record.created_at]) {
      const selected = timestamp(candidate); if (selected) candidates.push(selected);
    }
  }
  if (!candidates.length) throw new Error("GitHub metadata did not contain a usable timestamp.");
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export async function buildBrowserReceipt(snapshot, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generatedAtEpoch = Date.parse(generatedAt);
  const maxAgeHours = options.maxAgeHours ?? 168;
  if (!Number.isFinite(generatedAtEpoch) || new Date(generatedAtEpoch).toISOString() !== generatedAt) throw new Error("The observation time is invalid.");
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 24 * 365) throw new Error("The freshness window is invalid.");
  const target = snapshot.target ?? parsePullRequestUrl(options.rawUrl);
  const { base, head } = publicRepositorySides(snapshot.pull);
  const baseSha = typeof base.sha === "string" ? base.sha : "";
  const headSha = typeof head.sha === "string" ? head.sha : "";
  if (!FULL_GIT_SHA.test(baseSha) || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub did not return full base and head SHAs.");
  const pullState = lower(snapshot.pull.state);
  if (pullState !== "open" && pullState !== "closed") throw new Error("GitHub returned an unsupported pull-request state.");
  const merged = Boolean(snapshot.pull.merged_at ?? snapshot.pull.merged);
  const reviews = latestReviews(snapshot.reviews);
  const approvedReviews = reviews.filter((review) => lower(review.state) === "approved");
  const approvals = approvedReviews.length;
  const changesRequested = reviews.filter((review) => lower(review.state) === "changes_requested").length;
  const visibleChecks = latestVisibleChecks(snapshot.checkRuns, snapshot.statuses);
  const checks = {
    total: visibleChecks.length,
    passing: visibleChecks.filter((row) => row.state === "passing").length,
    failing: visibleChecks.filter((row) => row.state === "failing").length,
    pending: visibleChecks.filter((row) => row.state === "pending").length,
    unknown: visibleChecks.filter((row) => row.state === "unknown").length,
  };
  const latestAt = latestEvidenceAt(snapshot);
  const mergeAt = merged ? timestamp(snapshot.pull.merged_at) : undefined;
  const latestApprovalAt = approvedReviews.map((review) => timestamp(review.submitted_at)).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const successfulCheckTimes = visibleChecks.filter((row) => row.state === "passing" && row.at !== "1970-01-01T00:00:00.000Z").map((row) => row.at);
  const nonProvingConclusions = visibleChecks.filter((row) => NON_PROVING_CHECKS.has(row.conclusion)).length;
  const hasCompleteDecisiveTimestamps = Boolean(mergeAt && latestApprovalAt) && successfulCheckTimes.length === checks.total;
  const freshnessReferenceAt = hasCompleteDecisiveTimestamps ? [mergeAt, latestApprovalAt, ...successfulCheckTimes].sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;
  const rawLatestAgeHours = (generatedAtEpoch - Date.parse(latestAt)) / 3_600_000;
  const rawAgeHours = freshnessReferenceAt ? (generatedAtEpoch - Date.parse(freshnessReferenceAt)) / 3_600_000 : rawLatestAgeHours;
  const ageHours = Math.max(0, rawAgeHours);

  let continuity = "HOLD";
  const reasonCodes = [];
  let summary = "The public evidence is incomplete or does not establish a current merged approval.";
  let nextAction = "Resolve the missing or non-passing evidence and obtain repository-owned approval before a protected action.";
  if (rawLatestAgeHours < 0 || rawAgeHours < 0) {
    reasonCodes.push("evidence-after-observation-time");
    summary = "The selected observation time predates evidence returned by GitHub.";
    nextAction = "Use a current observation time and run the check again.";
  } else if (pullState === "closed" && !merged && approvals > 0) {
    continuity = "REVOKED";
    reasonCodes.push("approved-then-closed-unmerged");
    summary = "A formal approval exists, but the repository later closed the pull request without merging it.";
    nextAction = "Do not rely on the earlier approval; obtain a new repository-owned authorization for any successor change.";
  } else if (merged && approvals > 0 && changesRequested === 0 && checks.total > 0 && checks.failing === 0 && checks.pending === 0 && checks.unknown === 0 && snapshot.unavailable.length === 0 && freshnessReferenceAt) {
    if (ageHours > maxAgeHours) {
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
    if (nonProvingConclusions) reasonCodes.push("checks-neutral-or-skipped");
    if (checks.passing && successfulCheckTimes.length !== checks.passing) reasonCodes.push("check-timestamp-missing");
    if (snapshot.unavailable.length) reasonCodes.push("source-coverage-incomplete");
  }

  const unsigned = {
    schemaVersion: "agent-vigil-public-pr-receipt/v1",
    generatedAt,
    tool: { name: "@sulmusic/agent-vigil", version: TOOL_VERSION, commit: TOOL_COMMIT },
    subject: { url: target.url, repository: `${target.owner}/${target.repo}`, number: target.number, baseSha, headSha },
    observation: { pullRequestState: pullState, merged, approvals, changesRequested, checks, latestEvidenceAt: latestAt, freshnessReferenceAt, ageHours, maxAgeHours },
    decision: { continuity, allowsProtectedAction: false, reasonCodes: [...new Set(reasonCodes)].sort(), summary, nextAction },
    claimBoundary: { executionObserved: true, sufficiencyAssessed: false, statement: PUBLIC_CLAIM_STATEMENT },
    privacy: { publicMetadataOnly: true, sourceCodeFetched: false, sourceCodeRetained: false, promptsFetched: false, promptsRetained: false, transcriptsFetched: false, transcriptsRetained: false, requestBodiesSent: false },
    integration: { mode: "read-only-public-github-api", repositoryWritePermission: false, workflowChangeRequired: false, secretRetention: false },
    evidence: { sources: snapshot.sources, unavailable: [...snapshot.unavailable].sort() },
  };
  return { ...unsigned, receiptHash: await sha256(canonical(unsigned)) };
}

export function installationCommand() {
  return `npx --yes ${RELEASE_PACKAGE} protect --repo .`;
}

function validRepositorySlug(value) {
  const parts = typeof value === "string" ? value.split("/") : [];
  return parts.length === 2 && parts.every((part) => REPOSITORY_PART.test(part));
}

export function installationSteps(receipt) {
  prCommentMarkdown(receipt);
  const repository = receipt?.subject?.repository;
  if (!validRepositorySlug(repository)) throw new Error("A valid public repository is required before copying setup steps.");
  return [
    `# In a local checkout of ${repository}:`,
    installationCommand(),
    "git status --short",
    "# Review the four generated files, then commit them in a setup pull request.",
    "# After that setup commit merges:",
    `npx --yes ${RELEASE_PACKAGE} doctor --repo .`,
    "# PREPARED is not enforced. A plain required job name is not a workflow trust root.",
  ].join("\n");
}

export function adoptionRegistrationUrl(receipt) {
  prCommentMarkdown(receipt);
  const repository = receipt?.subject?.repository;
  if (!validRepositorySlug(repository)) throw new Error("A valid public repository is required before registering a trial.");
  return `${ADOPTION_FORM}&title=${encodeURIComponent(`[adoption] ${repository}`)}`;
}

export function prCommentMarkdown(receipt) {
  const continuity = receipt?.decision?.continuity;
  const subject = receipt?.subject;
  const checks = receipt?.observation?.checks;
  const reasonCodes = receipt?.decision?.reasonCodes;
  const receiptHash = receipt?.receiptHash;
  if (!["CURRENT", "HOLD", "EXPIRED", "REVOKED"].includes(continuity)
    || !subject || !FULL_GIT_SHA.test(subject.baseSha) || !FULL_GIT_SHA.test(subject.headSha)
    || !checks || ![checks.passing, checks.failing, checks.pending, checks.unknown].every((value) => integer(value) !== undefined)
    || !Array.isArray(reasonCodes) || reasonCodes.length > 16 || !reasonCodes.every((value) => typeof value === "string" && REASON_CODE.test(value))
    || typeof receiptHash !== "string" || !RECEIPT_SHA256.test(receiptHash)) {
    throw new Error("A complete browser receipt is required before copying a PR result.");
  }
  const gaps = reasonCodes.length ? reasonCodes.join(", ") : "none recorded";
  const reasonLabel = continuity === "CURRENT" ? "Observed" : "Unresolved";
  return [
    `**Agent Vigil public evidence: ${continuity}**`,
    "",
    `Checks: ${checks.passing} passing · ${checks.failing} failing · ${checks.pending} pending · ${checks.unknown} unknown`,
    `Base: \`${subject.baseSha}\``,
    `Head: \`${subject.headSha}\``,
    `${reasonLabel}: ${gaps}`,
    `Receipt: \`${receiptHash}\``,
    "",
    "[Check another public PR](https://sulmusic2-star.github.io/agent-vigil/check.html)",
    "",
    "_Read-only public metadata. This result does not authorize merge or deployment._",
  ].join("\n");
}

function text(element, value) { element.textContent = value; }
function setBusy(form, button, busy) {
  button.disabled = busy;
  form.setAttribute("aria-busy", busy ? "true" : "false");
  text(button, busy ? "Checking public evidence…" : "Check pull request");
}
function resultTitle(continuity) {
  if (continuity === "CURRENT") return "Public merge evidence is current.";
  if (continuity === "REVOKED") return "The earlier approval is no longer current.";
  if (continuity === "EXPIRED") return "The public evidence is too old.";
  return "Do not rely on this public evidence yet.";
}
function setLink(link, url) {
  if (typeof url === "string" && /^https:\/\/github\.com\//.test(url)) { link.href = url; link.hidden = false; }
  else { link.removeAttribute("href"); link.hidden = true; }
}

function renderCheckRows(container, rows) {
  container.replaceChildren();
  if (!rows.length) {
    const item = document.createElement("li");
    item.className = "check-row unknown";
    text(item, "No check runs or commit statuses were returned.");
    container.append(item);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("li");
    item.className = `check-row ${row.state}`;
    const state = document.createElement("span");
    state.className = "check-state";
    text(state, NON_PROVING_CHECKS.has(row.conclusion) ? `NOT CHECKED (${row.conclusion.toUpperCase()})` : row.state.toUpperCase());
    const name = document.createElement(row.url && /^https:\/\/github\.com\//.test(row.url) ? "a" : "span");
    text(name, row.name);
    if (name instanceof HTMLAnchorElement) { name.href = row.url; name.target = "_blank"; name.rel = "noreferrer"; }
    item.append(state, name);
    container.append(item);
  }
}

function downloadReceipt(receipt) {
  const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `agent-vigil-pr-${receipt.subject.number}.receipt.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyCommand(receipt, button, liveRegion) {
  await navigator.clipboard.writeText(installationSteps(receipt));
  text(button, "Setup steps copied");
  text(liveRegion, `Setup steps for ${receipt.subject.repository} were copied. Nothing was installed or posted.`);
  setTimeout(() => text(button, "Copy setup steps"), 2200);
}

async function copyPrComment(receipt, button, liveRegion) {
  await navigator.clipboard.writeText(prCommentMarkdown(receipt));
  text(button, "PR result copied");
  text(liveRegion, "A read-only Agent Vigil result was copied. Nothing was posted.");
  setTimeout(() => text(button, "Copy result for PR"), 2200);
}

function initialize() {
  const form = document.querySelector("#pr-check-form");
  if (!(form instanceof HTMLFormElement)) return;
  const input = document.querySelector("#pr-url");
  const submit = document.querySelector("#check-submit");
  const error = document.querySelector("#check-error");
  const result = document.querySelector("#check-result");
  const live = document.querySelector("#check-live");
  const download = document.querySelector("#download-receipt");
  const copyResult = document.querySelector("#copy-pr-result");
  const copy = document.querySelector("#copy-install");
  const register = document.querySelector("#register-trial");
  let selectedReceipt;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    result.hidden = true;
    selectedReceipt = undefined;
    setBusy(form, submit, true);
    try {
      const snapshot = await collectPublicPullRequest(input.value.trim());
      const receipt = await buildBrowserReceipt(snapshot);
      selectedReceipt = receipt;
      const rows = latestVisibleChecks(snapshot.checkRuns, snapshot.statuses);
      result.dataset.verdict = receipt.decision.continuity.toLowerCase();
      text(document.querySelector("#result-verdict"), receipt.decision.continuity);
      text(document.querySelector("#result-title"), resultTitle(receipt.decision.continuity));
      text(document.querySelector("#result-summary"), receipt.decision.summary);
      text(document.querySelector("#result-repo"), `${receipt.subject.repository} #${receipt.subject.number}`);
      text(document.querySelector("#result-claim"), typeof snapshot.pull.title === "string" ? snapshot.pull.title : "Title unavailable");
      text(document.querySelector("#result-change"), `${integer(snapshot.pull.changed_files) ?? "?"} files · +${integer(snapshot.pull.additions) ?? "?"} / −${integer(snapshot.pull.deletions) ?? "?"}`);
      text(document.querySelector("#result-review"), `${receipt.observation.approvals} approvals · ${receipt.observation.changesRequested} change requests`);
      text(document.querySelector("#result-checks"), `${receipt.observation.checks.passing} passing · ${receipt.observation.checks.failing} failing · ${receipt.observation.checks.pending} pending · ${receipt.observation.checks.unknown} unknown`);
      text(document.querySelector("#result-base"), receipt.subject.baseSha);
      text(document.querySelector("#result-head"), receipt.subject.headSha);
      text(document.querySelector("#result-gaps"), receipt.decision.reasonCodes.length ? receipt.decision.reasonCodes.join(" · ") : "none recorded");
      text(document.querySelector("#result-hash"), receipt.receiptHash);
      setLink(document.querySelector("#open-pr"), receipt.subject.url);
      setLink(register, adoptionRegistrationUrl(receipt));
      renderCheckRows(document.querySelector("#check-list"), rows);
      result.hidden = false;
      result.focus();
      text(live, `${receipt.decision.continuity}. ${resultTitle(receipt.decision.continuity)}`);
    } catch (caught) {
      text(error, caught instanceof Error ? caught.message : String(caught));
      error.hidden = false;
      error.focus();
      text(live, `Check failed. ${error.textContent}`);
    } finally {
      setBusy(form, submit, false);
    }
  });
  download.addEventListener("click", () => { if (selectedReceipt) downloadReceipt(selectedReceipt); });
  copyResult.addEventListener("click", () => {
    if (selectedReceipt) copyPrComment(selectedReceipt, copyResult, live).catch(() => text(live, "Copy failed. The result was not posted."));
  });
  copy.addEventListener("click", () => {
    if (selectedReceipt) copyCommand(selectedReceipt, copy, live).catch(() => text(live, `Copy failed. Run: ${installationCommand()}`));
  });
}

if (typeof document !== "undefined") initialize();

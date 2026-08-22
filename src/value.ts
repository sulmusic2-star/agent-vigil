import { createHash } from "node:crypto";
import { canonical, type ReportStatus, type TrustReport } from "./report.ts";
import type { SessionUsage } from "./transcript.ts";
import type { TrajectoryMetrics } from "./authority.ts";

export type CostSource = "provider-billed" | "subscription-allocated" | "user-estimated";
export type MaintainerDisposition = "accepted" | "dismissed" | "changes-requested" | "unreviewed";
export type ChangeOutcome = "merged" | "closed" | "reverted" | "hotfixed" | "incident-linked" | "unknown";
export type ValueVerdict = "POSITIVE" | "NEGATIVE" | "INCONCLUSIVE";

export type ValueInputs = {
  taskClass?: string;
  budgetUsd?: number;
  costUsd?: number;
  costSource?: CostSource;
  costEvidenceSha256?: string;
  reviewMinutes?: number;
  disposition?: MaintainerDisposition;
  reviewEvidenceSha256?: string;
  outcome?: ChangeOutcome;
  outcomeAsOf?: string;
  outcomeEvidenceSha256?: string;
  github?: {
    evidenceHash: string;
    pullRequestNumber?: number;
    approvals?: number;
    changesRequested?: number;
    reviewComments?: number;
    actionsRunDurationSeconds?: number;
    actionsJobDurationSeconds?: number;
    actionsJobs?: number;
    actionsFailedJobs?: number;
    actionsBilling: "UNAVAILABLE";
  };
  trajectory?: TrajectoryMetrics;
};

export type AgentValueCard = {
  schemaVersion: "agent-vigil-value-card/v1";
  generatedAt: string;
  cardHash: string;
  receipt: {
    receiptHash: string;
    hashValid: true;
    signature: "VALID_PINNED" | "VALID_SELF_ASSERTED" | "UNSIGNED";
    verificationStatus: ReportStatus;
    base: string;
    head: string;
    transcriptSha256: string;
    transcriptFormat: string;
  };
  task: {
    taskClass?: string;
    budgetUsd?: number;
    budgetStatus: "WITHIN" | "EXCEEDED" | "UNAVAILABLE";
  };
  agent: {
    adapter: string;
    modelIds: string[];
    toolCalls?: number;
    failedToolCalls?: number;
  };
  usage: SessionUsage | { status: "UNAVAILABLE" };
  cost: {
    status: "UNAVAILABLE" | "SELF_ASSERTED" | "EVIDENCE_HASHED";
    amountUsd?: number;
    source?: CostSource;
    evidenceSha256?: string;
  };
  human: {
    disposition: MaintainerDisposition;
    reviewMinutes?: number;
    evidence: "UNAVAILABLE" | "SELF_ASSERTED" | "EVIDENCE_HASHED";
    evidenceSha256?: string;
  };
  outcome: {
    state: ChangeOutcome;
    asOf?: string;
    evidence: "UNAVAILABLE" | "SELF_ASSERTED" | "EVIDENCE_HASHED";
    evidenceSha256?: string;
  };
  github?: ValueInputs["github"];
  trajectory?: TrajectoryMetrics;
  metrics: {
    costPerVerifiedChangeUsd?: number;
    costPerAcceptedChangeUsd?: number;
    reviewMinutesPerVerifiedChange?: number;
  };
  valueVerdict: ValueVerdict;
  gaps: string[];
};

function nonNegative(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a non-negative number`);
}

function validAsOf(value: string | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(new Date(value).getTime())) throw new Error("outcome as-of must be an RFC3339-compatible timestamp");
}

function cardPayload(card: Omit<AgentValueCard, "cardHash">): string {
  // Observation time is presentation metadata. Excluding it keeps the evidence
  // identity stable when the same inputs are rendered again later.
  const { generatedAt: _generatedAt, ...evidence } = card;
  return canonical(evidence);
}

export function recomputeValueCardHash(card: AgentValueCard): string {
  const { cardHash: _cardHash, ...withoutHash } = card;
  return `sha256:${createHash("sha256").update(cardPayload(withoutHash)).digest("hex")}`;
}

export function buildValueCard(input: {
  report: TrustReport;
  hashValid: true;
  signatureValid?: boolean;
  keyPinned?: boolean;
  usage?: SessionUsage;
  toolCalls?: number;
  failedToolCalls?: number;
  values: ValueInputs;
}): AgentValueCard {
  nonNegative(input.values.budgetUsd, "budget USD");
  nonNegative(input.values.costUsd, "cost USD");
  nonNegative(input.values.reviewMinutes, "review minutes");
  validAsOf(input.values.outcomeAsOf);
  if (input.values.costUsd !== undefined && !input.values.costSource) throw new Error("cost source is required when cost USD is provided");
  if (input.values.costSource && input.values.costUsd === undefined) throw new Error("cost USD is required when cost source is provided");
  if (input.values.costEvidenceSha256 && input.values.costUsd === undefined) throw new Error("cost USD is required when cost evidence is provided");
  if (input.values.reviewEvidenceSha256 && input.values.disposition === undefined && input.values.reviewMinutes === undefined) {
    throw new Error("review evidence requires a disposition or review duration");
  }
  if (input.values.outcomeAsOf && (!input.values.outcome || input.values.outcome === "unknown")) {
    throw new Error("outcome as-of requires a known outcome");
  }
  if (input.values.outcomeEvidenceSha256 && (!input.values.outcome || input.values.outcome === "unknown")) {
    throw new Error("outcome evidence requires a known outcome");
  }

  const disposition = input.values.disposition ?? "unreviewed";
  const outcome = input.values.outcome ?? "unknown";
  const negative = input.report.summary.status === "FAIL"
    || disposition === "dismissed"
    || outcome === "reverted"
    || outcome === "hotfixed"
    || outcome === "incident-linked";
  const accepted = disposition === "accepted" || outcome === "merged";
  const acceptedEvidence = (disposition === "accepted" && input.values.reviewEvidenceSha256 !== undefined)
    || (outcome === "merged" && input.values.outcomeEvidenceSha256 !== undefined);
  const positive = input.report.summary.status === "PASS"
    && accepted
    && acceptedEvidence
    && input.values.costEvidenceSha256 !== undefined;
  const valueVerdict: ValueVerdict = negative ? "NEGATIVE" : positive ? "POSITIVE" : "INCONCLUSIVE";

  const gaps: string[] = [];
  if (input.report.summary.status === "INCONCLUSIVE") gaps.push("verification receipt is INCONCLUSIVE");
  if (!input.usage) gaps.push("transcript contains no supported token-usage evidence");
  else if (!input.usage.modelIds.length) gaps.push("agent model identity is unavailable");
  if (input.values.costUsd === undefined) gaps.push("task cost is unavailable");
  else if (!input.values.costEvidenceSha256) gaps.push("task cost is self-asserted without hashed billing evidence");
  if (disposition === "unreviewed") gaps.push("maintainer disposition is unreviewed");
  else if (!input.values.reviewEvidenceSha256) gaps.push("maintainer disposition is self-asserted without hashed review evidence");
  if (input.values.reviewMinutes === undefined) gaps.push("human review time is unavailable");
  if (outcome === "unknown") gaps.push("downstream change outcome is unknown");
  else if (!input.values.outcomeEvidenceSha256) gaps.push("downstream change outcome is self-asserted without hashed outcome evidence");

  const budgetStatus = input.values.budgetUsd === undefined || input.values.costUsd === undefined
    ? "UNAVAILABLE"
    : input.values.costUsd <= input.values.budgetUsd ? "WITHIN" : "EXCEEDED";
  const signature = input.signatureValid === true
    ? input.keyPinned ? "VALID_PINNED" : "VALID_SELF_ASSERTED"
    : "UNSIGNED";
  const costStatus = input.values.costUsd === undefined
    ? "UNAVAILABLE"
    : input.values.costEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED";
  const metrics: AgentValueCard["metrics"] = {};
  if (input.report.summary.status === "PASS" && input.values.costUsd !== undefined) metrics.costPerVerifiedChangeUsd = input.values.costUsd;
  if (input.report.summary.status === "PASS" && accepted && input.values.costUsd !== undefined) metrics.costPerAcceptedChangeUsd = input.values.costUsd;
  if (input.report.summary.status === "PASS" && input.values.reviewMinutes !== undefined) metrics.reviewMinutesPerVerifiedChange = input.values.reviewMinutes;

  const withoutHash: Omit<AgentValueCard, "cardHash"> = {
    schemaVersion: "agent-vigil-value-card/v1",
    generatedAt: new Date().toISOString(),
    receipt: {
      receiptHash: input.report.receiptHash,
      hashValid: true,
      signature,
      verificationStatus: input.report.summary.status,
      base: input.report.base,
      head: input.report.head,
      transcriptSha256: input.report.transcriptSha256,
      transcriptFormat: input.report.transcriptFormat,
    },
    task: {
      ...(input.values.taskClass ? { taskClass: input.values.taskClass } : {}),
      ...(input.values.budgetUsd !== undefined ? { budgetUsd: input.values.budgetUsd } : {}),
      budgetStatus,
    },
    agent: {
      adapter: input.report.transcriptFormat.replace(/^authority\//, ""),
      modelIds: input.usage?.modelIds ?? [],
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.failedToolCalls !== undefined ? { failedToolCalls: input.failedToolCalls } : {}),
    },
    usage: input.usage ?? { status: "UNAVAILABLE" },
    cost: {
      status: costStatus,
      ...(input.values.costUsd !== undefined ? { amountUsd: input.values.costUsd } : {}),
      ...(input.values.costSource ? { source: input.values.costSource } : {}),
      ...(input.values.costEvidenceSha256 ? { evidenceSha256: input.values.costEvidenceSha256 } : {}),
    },
    human: {
      disposition,
      ...(input.values.reviewMinutes !== undefined ? { reviewMinutes: input.values.reviewMinutes } : {}),
      evidence: disposition === "unreviewed" && input.values.reviewMinutes === undefined
        ? "UNAVAILABLE"
        : input.values.reviewEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED",
      ...(input.values.reviewEvidenceSha256 ? { evidenceSha256: input.values.reviewEvidenceSha256 } : {}),
    },
    outcome: {
      state: outcome,
      ...(input.values.outcomeAsOf ? { asOf: new Date(input.values.outcomeAsOf).toISOString() } : {}),
      evidence: outcome === "unknown"
        ? "UNAVAILABLE"
        : input.values.outcomeEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED",
      ...(input.values.outcomeEvidenceSha256 ? { evidenceSha256: input.values.outcomeEvidenceSha256 } : {}),
    },
    ...(input.values.github ? { github: input.values.github } : {}),
    ...(input.values.trajectory ? { trajectory: input.values.trajectory } : {}),
    metrics,
    valueVerdict,
    gaps,
  };
  const card: AgentValueCard = {
    ...withoutHash,
    cardHash: "",
  };
  card.cardHash = recomputeValueCardHash(card);
  return card;
}

function money(value: number | undefined): string {
  return value === undefined ? "unavailable" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export function renderValueCardText(card: AgentValueCard): string {
  const lines = [
    `Agent Vigil Value Card · ${card.valueVerdict}`,
    `  verification: ${card.receipt.verificationStatus} · ${card.receipt.signature}`,
    `  task:         ${card.task.taskClass ?? "unclassified"}`,
    `  agent:        ${card.agent.adapter}${card.agent.modelIds.length ? ` · ${card.agent.modelIds.join(", ")}` : " · model unknown"}`,
    `  cost:         ${money(card.cost.amountUsd)} · ${card.cost.status}${card.cost.source ? ` · ${card.cost.source}` : ""}`,
    `  budget:       ${money(card.task.budgetUsd)} · ${card.task.budgetStatus}`,
    `  disposition:  ${card.human.disposition}${card.human.reviewMinutes !== undefined ? ` · ${card.human.reviewMinutes} review minute(s)` : ""}`,
    `  outcome:      ${card.outcome.state}${card.outcome.asOf ? ` · as of ${card.outcome.asOf}` : ""}`,
    `  tokens:       ${"status" in card.usage ? "unavailable" : `${card.usage.totalTokens.toLocaleString("en-US")} · ${card.usage.accounting}`}`,
    `  receipt:      ${card.receipt.receiptHash}`,
    `  card:         ${card.cardHash}`,
  ];
  if (card.metrics.costPerAcceptedChangeUsd !== undefined) lines.push(`  value metric: ${money(card.metrics.costPerAcceptedChangeUsd)} per accepted verified change`);
  if (card.gaps.length) {
    lines.push("  evidence gaps:");
    for (const gap of card.gaps) lines.push(`    - ${gap}`);
  }
  return `${lines.join("\n")}\n`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderValueCardMarkdown(card: AgentValueCard): string {
  const rows = [
    ["Value verdict", card.valueVerdict],
    ["Verification", card.receipt.verificationStatus],
    ["Task class", card.task.taskClass ?? "unclassified"],
    ["Agent", `${card.agent.adapter}${card.agent.modelIds.length ? ` · ${card.agent.modelIds.join(", ")}` : " · model unknown"}`],
    ["Cost", `${money(card.cost.amountUsd)} · ${card.cost.status}`],
    ["Budget", `${money(card.task.budgetUsd)} · ${card.task.budgetStatus}`],
    ["Maintainer", `${card.human.disposition} · ${card.human.evidence}${card.human.reviewMinutes !== undefined ? ` · ${card.human.reviewMinutes} minutes` : ""}`],
    ["Outcome", `${card.outcome.state} · ${card.outcome.evidence}`],
    ["Tokens", "status" in card.usage ? "unavailable" : card.usage.totalTokens.toLocaleString("en-US")],
  ];
  return [
    "# Agent Vigil Value Card",
    "",
    "| Evidence | Result |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
    "",
    ...(card.gaps.length ? ["## Evidence gaps", "", ...card.gaps.map((gap) => `- ${gap}`), ""] : []),
    `Receipt: \`${card.receipt.receiptHash}\``,
    "",
    `Card: \`${card.cardHash}\``,
    "",
    "Generated locally by [Agent Vigil](https://github.com/sulmusic2-star/agent-vigil).",
    "",
  ].join("\n");
}

function html(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function readableLabel(value: string): string {
  const words = value.toLowerCase().replace(/[-_]+/g, " ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

export function renderValueCardHtml(card: AgentValueCard): string {
  const statusClass = card.valueVerdict.toLowerCase();
  const verdict = readableLabel(card.valueVerdict);
  const tokenText = "status" in card.usage ? "Unavailable" : card.usage.totalTokens.toLocaleString("en-US");
  const gapItems = card.gaps.length ? card.gaps.map((gap) => `<li>${html(gap)}</li>`).join("") : "<li>None recorded</li>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Vigil Value Card</title><style>
:root{--paper:#f3f0e8;--ink:#18202a;--muted:#5f6870;--rule:#c9c1b4;--accent:#2d5f73;--pass:#28734e;--fail:#a13d32;--warn:#8a611c;--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;--code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}*{box-sizing:border-box}html,body{overflow-x:clip}body{margin:0;padding:44px 20px;background:var(--paper);color:var(--ink);font:16px/1.55 var(--body)}.wrap{max-width:920px;margin:auto}.kicker{color:var(--accent);font-weight:700}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.55fr);gap:32px;align-items:end;margin:14px 0 32px;padding-bottom:28px;border-bottom:1px solid var(--rule)}.verdict{margin:0;font:600 clamp(46px,8vw,76px)/1 var(--display);letter-spacing:-.025em}.summary{margin:0;color:var(--muted)}.positive{color:var(--pass)}.negative{color:var(--fail)}.inconclusive{color:var(--warn)}.records{margin:0}.record{display:grid;grid-template-columns:minmax(150px,.5fr) minmax(0,1fr);gap:24px;padding:18px 0;border-bottom:1px solid var(--rule)}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}dd strong{display:block;font:600 23px/1.2 var(--display)}dd span{display:block;margin-top:5px;color:var(--muted)}.section{margin-top:34px}.section h2{font:600 25px/1.2 var(--display)}.hash{font:12px/1.6 var(--code);overflow-wrap:anywhere}footer{margin-top:38px;padding-top:20px;border-top:1px solid var(--rule);color:var(--muted);font-size:13px}a{color:var(--accent)}@media(max-width:620px){.hero,.record{grid-template-columns:1fr;gap:8px}.hero{align-items:start}}
</style></head><body><main class="wrap">
<div class="kicker">Agent Vigil value record</div><section class="hero"><h1 class="verdict ${statusClass}">${html(verdict)}</h1><p class="summary">${html(card.receipt.verificationStatus)} verification<br>${html(card.task.taskClass ?? "Task class not recorded")}</p></section>
<dl class="records">
<div class="record"><dt>Agent</dt><dd><strong>${html(card.agent.adapter)}</strong><span>${html(card.agent.modelIds.join(", ") || "Model not recorded")}</span></dd></div>
<div class="record"><dt>Attributed cost</dt><dd><strong>${html(money(card.cost.amountUsd))}</strong><span>${html(readableLabel(card.cost.status))}</span></dd></div>
<div class="record"><dt>Budget</dt><dd><strong>${html(readableLabel(card.task.budgetStatus))}</strong><span>${html(money(card.task.budgetUsd))}</span></dd></div>
<div class="record"><dt>Maintainer decision</dt><dd><strong>${html(readableLabel(card.human.disposition))}</strong><span>${html(`${readableLabel(card.human.evidence)}${card.human.reviewMinutes === undefined ? " · review time not recorded" : ` · ${card.human.reviewMinutes} review ${card.human.reviewMinutes === 1 ? "minute" : "minutes"}`}`)}</span></dd></div>
<div class="record"><dt>Later outcome</dt><dd><strong>${html(readableLabel(card.outcome.state))}</strong><span>${html(`${readableLabel(card.outcome.evidence)}${card.outcome.asOf ? ` · through ${card.outcome.asOf}` : " · date not recorded"}`)}</span></dd></div>
<div class="record"><dt>Observed tokens</dt><dd><strong>${html(tokenText)}</strong><span>${html("status" in card.usage ? "No supported usage record" : readableLabel(card.usage.accounting))}</span></dd></div>
</dl>
<section class="section"><h2>Evidence gaps</h2><ul>${gapItems}</ul></section>
<section class="section"><h2>Integrity</h2><p class="hash">Receipt ${html(card.receipt.receiptHash)}</p><p class="hash">Card ${html(card.cardHash)}</p></section>
<footer>Local evidence card generated by <a href="https://github.com/sulmusic2-star/agent-vigil">Agent Vigil</a>. A PASS receipt is not proof that code is bug-free, and missing cost or outcome evidence remains INCONCLUSIVE.</footer>
</main></body></html>\n`;
}

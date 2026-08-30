import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { recomputeValueCardHash, type AgentValueCard } from "./value.ts";
import { readRegularUtf8 } from "./safe-fs.ts";

export type WilsonInterval = { lower: number; upper: number; confidence: 0.95 };

export type ValueComparisonGroup = {
  taskClass: string;
  agent: string;
  models: string[];
  episodes: number;
  positive: number;
  negative: number;
  inconclusive: number;
  conclusive: number;
  positiveRate?: number;
  positiveRateWilson95?: WilsonInterval;
  hashedCostEpisodes: number;
  costEvidenceCompleteness: number;
  observedHashedCostUsd: number;
  costPerPositiveUsd?: number;
  accepted: number;
  revertedOrHotfixedOrIncident: number;
  reviewMinutesObserved: number;
  medianReviewMinutes?: number;
};

export type ValueComparison = {
  schemaVersion: "agent-vigil-value-comparison/v1";
  generatedAt: string;
  inputFiles: number;
  uniqueEpisodes: number;
  supersededCards: number;
  comparableTaskClasses: string[];
  status: "COMPARABLE" | "INCONCLUSIVE";
  groups: ValueComparisonGroup[];
  warnings: string[];
};

const MAX_CARD_BYTES = 8 * 1024 * 1024;

function validCard(value: any, path: string): AgentValueCard {
  if (value?.schemaVersion !== "agent-vigil-value-card/v1") throw new Error(`${path} is not an Agent Value Card v1`);
  if (typeof value.cardHash !== "string" || typeof value.receipt?.receiptHash !== "string") throw new Error(`${path} lacks value-card integrity fields`);
  if (!new Set(["POSITIVE", "NEGATIVE", "INCONCLUSIVE"]).has(value.valueVerdict)) throw new Error(`${path} has an invalid value verdict`);
  if (recomputeValueCardHash(value) !== value.cardHash) throw new Error(`${path} value-card hash is invalid`);
  return value as AgentValueCard;
}

export function loadValueCard(path: string): AgentValueCard {
  let value: unknown;
  try { value = JSON.parse(readRegularUtf8(path, MAX_CARD_BYTES, "value card")); }
  catch { throw new Error(`${path} is not valid JSON`); }
  return validCard(value, path);
}

export function wilson95(successes: number, total: number): WilsonInterval | undefined {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total <= 0 || successes > total) return undefined;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: 0.95 };
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function observationTime(card: AgentValueCard): number {
  const value = card.outcome.asOf ?? card.generatedAt;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareValueCards(cards: AgentValueCard[], inputFiles = cards.length): ValueComparison {
  const byReceipt = new Map<string, AgentValueCard>();
  let supersededCards = 0;
  for (const card of cards) {
    validCard(card, "in-memory card");
    const key = card.receipt.receiptHash;
    const prior = byReceipt.get(key);
    if (!prior) byReceipt.set(key, card);
    else {
      supersededCards += 1;
      if (observationTime(card) > observationTime(prior) || (observationTime(card) === observationTime(prior) && card.cardHash > prior.cardHash)) byReceipt.set(key, card);
    }
  }
  const episodes = [...byReceipt.values()];
  const grouped = new Map<string, AgentValueCard[]>();
  for (const card of episodes) {
    const taskClass = card.task.taskClass ?? "unclassified";
    const models = card.agent.modelIds.length ? card.agent.modelIds.join(",") : "model-unknown";
    const key = JSON.stringify([taskClass, card.agent.adapter, models]);
    grouped.set(key, [...(grouped.get(key) ?? []), card]);
  }
  const groups: ValueComparisonGroup[] = [...grouped.entries()].map(([key, values]) => {
    const [taskClass, agent, modelText] = JSON.parse(key) as [string, string, string];
    const positive = values.filter((card) => card.valueVerdict === "POSITIVE").length;
    const negative = values.filter((card) => card.valueVerdict === "NEGATIVE").length;
    const conclusive = positive + negative;
    const hashedCosts = values.filter((card) => card.cost.status === "EVIDENCE_HASHED" && card.cost.amountUsd !== undefined);
    const observedHashedCostUsd = hashedCosts.reduce((sum, card) => sum + (card.cost.amountUsd ?? 0), 0);
    const reviewMinutes = values.map((card) => card.human.reviewMinutes).filter((value): value is number => value !== undefined);
    return {
      taskClass,
      agent,
      models: modelText === "model-unknown" ? [] : modelText.split(","),
      episodes: values.length,
      positive,
      negative,
      inconclusive: values.length - conclusive,
      conclusive,
      ...(conclusive ? { positiveRate: positive / conclusive, positiveRateWilson95: wilson95(positive, conclusive) } : {}),
      hashedCostEpisodes: hashedCosts.length,
      costEvidenceCompleteness: values.length ? hashedCosts.length / values.length : 0,
      observedHashedCostUsd,
      ...(hashedCosts.length === values.length && positive ? { costPerPositiveUsd: observedHashedCostUsd / positive } : {}),
      accepted: values.filter((card) => card.human.disposition === "accepted" || card.outcome.state === "merged").length,
      revertedOrHotfixedOrIncident: values.filter((card) => new Set(["reverted", "hotfixed", "incident-linked"]).has(card.outcome.state)).length,
      reviewMinutesObserved: reviewMinutes.length,
      ...(median(reviewMinutes) !== undefined ? { medianReviewMinutes: median(reviewMinutes) } : {}),
    };
  }).sort((left, right) => left.taskClass.localeCompare(right.taskClass) || left.agent.localeCompare(right.agent) || left.models.join().localeCompare(right.models.join()));

  const byTask = new Map<string, ValueComparisonGroup[]>();
  for (const group of groups) byTask.set(group.taskClass, [...(byTask.get(group.taskClass) ?? []), group]);
  const comparableTaskClasses = [...byTask.entries()].filter(([, values]) => values.length >= 2 && values.every((group) => group.episodes >= 5 && group.conclusive >= 5 && group.costEvidenceCompleteness >= 0.8)).map(([task]) => task).sort();
  const warnings: string[] = [];
  if (!episodes.length) warnings.push("no unique value episodes were supplied");
  if (!comparableTaskClasses.length) warnings.push("no task class has at least two agent groups with 5 episodes, 5 conclusive outcomes, and 80% hashed-cost completeness each");
  for (const group of groups) {
    const label = `${group.taskClass}/${group.agent}${group.models.length ? `/${group.models.join(",")}` : ""}`;
    if (group.episodes < 5) warnings.push(`${label}: only ${group.episodes} episode(s); do not rank this group`);
    if (group.costEvidenceCompleteness < 0.8) warnings.push(`${label}: hashed-cost completeness is ${(group.costEvidenceCompleteness * 100).toFixed(1)}%`);
    if (group.conclusive < group.episodes) warnings.push(`${label}: ${group.episodes - group.conclusive} episode(s) remain INCONCLUSIVE`);
  }
  return {
    schemaVersion: "agent-vigil-value-comparison/v1",
    generatedAt: new Date().toISOString(),
    inputFiles,
    uniqueEpisodes: episodes.length,
    supersededCards,
    comparableTaskClasses,
    status: comparableTaskClasses.length ? "COMPARABLE" : "INCONCLUSIVE",
    groups,
    warnings,
  };
}

function percent(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

export function renderValueComparisonText(comparison: ValueComparison): string {
  const lines = [
    `Agent Vigil Value Comparison · ${comparison.status}`,
    `  ${comparison.uniqueEpisodes} unique episode(s) · ${comparison.supersededCards} superseded card(s)`,
  ];
  for (const group of comparison.groups) {
    const interval = group.positiveRateWilson95;
    lines.push("", `${group.taskClass} · ${group.agent}${group.models.length ? ` · ${group.models.join(", ")}` : ""}`);
    lines.push(`  n=${group.episodes} · positive=${group.positive} · negative=${group.negative} · inconclusive=${group.inconclusive}`);
    lines.push(`  positive rate: ${percent(group.positiveRate)}${interval ? ` · Wilson 95% ${percent(interval.lower)}–${percent(interval.upper)}` : ""}`);
    lines.push(`  hashed cost: ${percent(group.costEvidenceCompleteness)} complete · $${group.observedHashedCostUsd.toFixed(2)} observed${group.costPerPositiveUsd !== undefined ? ` · $${group.costPerPositiveUsd.toFixed(2)} per positive` : ""}`);
    lines.push(`  review time: ${group.medianReviewMinutes === undefined ? "unavailable" : `${group.medianReviewMinutes.toFixed(1)} minute median`} · ${group.revertedOrHotfixedOrIncident} adverse downstream outcome(s)`);
  }
  if (comparison.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of comparison.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function html(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

export function renderValueComparisonHtml(comparison: ValueComparison): string {
  const groups = comparison.groups.map((group) => {
    const interval = group.positiveRateWilson95;
    return `<article class="record"><header><p>${html(group.taskClass)}</p><h2>${html(group.agent)}</h2><p>${html(group.models.join(", ") || "Model not recorded")}</p></header><dl><div><dt>Sample</dt><dd>${group.episodes} changes</dd></div><div><dt>Positive records</dt><dd>${html(percent(group.positiveRate))}${interval ? ` <span>95% range ${html(percent(interval.lower))}–${html(percent(interval.upper))}</span>` : ""}</dd></div><div><dt>Cost records</dt><dd>${html(percent(group.costEvidenceCompleteness))} complete${group.costPerPositiveUsd !== undefined ? ` <span>$${group.costPerPositiveUsd.toFixed(2)} per positive record</span>` : ""}</dd></div><div><dt>Later problems</dt><dd>${group.revertedOrHotfixedOrIncident}</dd></div></dl></article>`;
  }).join("");
  const warnings = comparison.warnings.length ? comparison.warnings.map((warning) => `<li>${html(warning)}</li>`).join("") : "<li>None</li>";
  const heading = comparison.status === "COMPARABLE" ? "Comparable records" : "Not enough comparable records";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Vigil Value Comparison</title><style>:root{--paper:#f3f0e8;--ink:#18202a;--muted:#5f6870;--rule:#c9c1b4;--accent:#2d5f73;--warn:#8a611c;--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}*{box-sizing:border-box}html,body{overflow-x:clip}body{margin:0;padding:44px 20px;background:var(--paper);color:var(--ink);font:16px/1.55 var(--body)}.wrap{max-width:1040px;margin:auto}.kicker{color:var(--accent);font-weight:700}h1{max-width:760px;margin:10px 0 14px;font:600 clamp(44px,7vw,72px)/1 var(--display);letter-spacing:-.025em}.summary{max-width:68ch;color:var(--muted)}.records{margin-top:36px;border-top:1px solid var(--rule)}.record{display:grid;grid-template-columns:minmax(200px,.55fr) minmax(0,1fr);gap:36px;padding:28px 0;border-bottom:1px solid var(--rule)}.record header p{margin:0;color:var(--muted)}.record h2{margin:4px 0;font:600 28px/1.2 var(--display)}dl{margin:0}dl div{display:grid;grid-template-columns:minmax(130px,.45fr) minmax(0,1fr);gap:18px;padding:8px 0}dt{color:var(--muted)}dd{margin:0;font-weight:650}dd span{display:block;color:var(--muted);font-weight:400}.warnings{margin-top:36px;padding:22px 0;border-block:1px solid var(--rule)}.warnings h2{font:600 25px/1.2 var(--display)}.note{margin-top:28px;color:var(--muted);font-size:13px}a{color:var(--accent)}@media(max-width:680px){.record,dl div{grid-template-columns:1fr;gap:6px}}</style></head><body><main class="wrap"><div class="kicker">Agent Vigil value comparison</div><h1>${heading}</h1><p class="summary">${comparison.uniqueEpisodes} unique changes · ${comparison.supersededCards} replaced records · ${comparison.comparableTaskClasses.length} comparable task classes</p><section class="records">${groups}</section><section class="warnings"><h2>Limits and warnings</h2><ul>${warnings}</ul></section><p class="note">Generated locally by <a href="https://github.com/sulmusic2-star/agent-vigil">Agent Vigil</a>. The 95% ranges show sampling uncertainty. They do not remove task-selection bias or prove that an agent caused the outcome.</p></main></body></html>\n`;
}

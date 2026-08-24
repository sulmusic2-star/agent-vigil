import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical, VERSION } from "../report.ts";
import { publicKeyDer, signingKeyId, type VerificationResult } from "../signature.ts";
import {
  verifyPublicCompatibilityEntry,
  type PublicCompatibilityEntry,
  type PublicSignature,
} from "./receipt.ts";
import { terminalSafe } from "./presentation.ts";

export const COMPATIBILITY_RESOLUTION_SCHEMA = "agent-vigil-compatibility-resolution/v1" as const;
export const COMPATIBILITY_REGISTRY_SCHEMA = "agent-vigil-compatibility-registry/v1" as const;

export type CompatibilityResolution = {
  schemaVersion: typeof COMPATIBILITY_RESOLUTION_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  component: { ecosystem: string; name: string };
  broken: {
    entryHash: string;
    baselineVersion: string;
    brokenVersion: string;
    brokenArtifactSha256: string;
  };
  fixed: {
    entryHash: string;
    baselineVersion: string;
    fixedVersion: string;
    fixedArtifactSha256: string;
  };
  relation: "RESTORED_RECORDED_COMPATIBILITY";
  limitations: string[];
  resolutionHash: string;
  signature: PublicSignature;
};

export type CompatibilityRegistry = {
  schemaVersion: typeof COMPATIBILITY_REGISTRY_SCHEMA;
  generatedAt: string;
  entries: PublicCompatibilityEntry[];
  resolutions: CompatibilityResolution[];
  summary: {
    entries: number;
    safe: number;
    changed: number;
    hold: number;
    resolvedBreakages: number;
    components: number;
  };
  registryHash: string;
};

const RESOLUTION_LIMITATIONS = [
  "The fixed entry restores the recorded baseline canary behavior; it does not prove universal correctness or that every user-visible regression was fixed.",
  "The relation is valid only for entries signed by the same pinned publisher and for identical baseline, runner, configuration, and canary-harness commitments.",
];

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = text(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be an exact SHA-256 commitment`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
  return result;
}

function resolutionPayload(value: Omit<CompatibilityResolution, "resolutionHash" | "signature">): string {
  return canonical(value);
}

function sameRunner(left: PublicCompatibilityEntry, right: PublicCompatibilityEntry): boolean {
  return canonical(left.runner) === canonical(right.runner);
}

function assertFixedEntryIsLater(
  broken: PublicCompatibilityEntry,
  fixed: PublicCompatibilityEntry,
): void {
  const brokenGeneratedAt = timestamp(broken.generatedAt, "broken compatibility entry generatedAt");
  const fixedGeneratedAt = timestamp(fixed.generatedAt, "fixed compatibility entry generatedAt");
  if (Date.parse(fixedGeneratedAt) <= Date.parse(brokenGeneratedAt)) {
    throw new Error("fixed compatibility entry must be generated strictly later than the broken compatibility entry");
  }
}

export function createCompatibilityResolution(input: {
  broken: PublicCompatibilityEntry;
  fixed: PublicCompatibilityEntry;
  privateKeyPath: string;
  generatedAt?: string;
}): CompatibilityResolution {
  const inputRecord = record(input, "compatibility resolution input");
  exactKeys(inputRecord, ["broken", "fixed", "privateKeyPath", "generatedAt"], "compatibility resolution input");
  const brokenVerification = verifyPublicCompatibilityEntry(input.broken);
  const fixedVerification = verifyPublicCompatibilityEntry(input.fixed);
  if (!brokenVerification.hashValid || brokenVerification.signatureValid !== true
    || !fixedVerification.hashValid || fixedVerification.signatureValid !== true) {
    throw new Error("resolution inputs must be valid signed compatibility entries");
  }
  if (input.broken.signature.keyId !== input.fixed.signature.keyId) {
    throw new Error("resolution inputs must share one publisher identity");
  }
  if (input.broken.verdict !== "CHANGED") throw new Error("broken entry must have verdict CHANGED");
  if (input.fixed.verdict !== "SAFE") throw new Error("fixed entry must have verdict SAFE");
  assertFixedEntryIsLater(input.broken, input.fixed);
  if (input.broken.component.ecosystem !== input.fixed.component.ecosystem
    || input.broken.component.name !== input.fixed.component.name) {
    throw new Error("resolution entries must describe the same component");
  }
  if (input.broken.component.currentVersion !== input.fixed.component.currentVersion
    || input.broken.component.currentArtifactSha256 !== input.fixed.component.currentArtifactSha256) {
    throw new Error("resolution entries must use the same exact baseline");
  }
  if (!sameRunner(input.broken, input.fixed)) {
    throw new Error("resolution entries must use the same exact runner, config, and canary harness");
  }
  if (input.broken.component.candidateVersion === input.fixed.component.candidateVersion
    || input.broken.component.candidateArtifactSha256 === input.fixed.component.candidateArtifactSha256) {
    throw new Error("fixed candidate must be distinct from the recorded broken candidate");
  }
  const privateKey = createPrivateKey(readFileSync(input.privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("resolution signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const keyId = signingKeyId(der);
  if (keyId !== input.broken.signature.keyId) {
    throw new Error("resolution signing key must match the compatibility-entry publisher");
  }
  const unsigned = {
    schemaVersion: COMPATIBILITY_RESOLUTION_SCHEMA,
    vigilVersion: VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    component: {
      ecosystem: input.broken.component.ecosystem,
      name: input.broken.component.name,
    },
    broken: {
      entryHash: input.broken.entryHash,
      baselineVersion: input.broken.component.currentVersion,
      brokenVersion: input.broken.component.candidateVersion,
      brokenArtifactSha256: input.broken.component.candidateArtifactSha256,
    },
    fixed: {
      entryHash: input.fixed.entryHash,
      baselineVersion: input.fixed.component.currentVersion,
      fixedVersion: input.fixed.component.candidateVersion,
      fixedArtifactSha256: input.fixed.component.candidateArtifactSha256,
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY",
    limitations: RESOLUTION_LIMITATIONS,
  } satisfies Omit<CompatibilityResolution, "resolutionHash" | "signature">;
  const resolutionHash = hash(resolutionPayload(unsigned));
  const value: CompatibilityResolution = {
    ...unsigned,
    resolutionHash,
    signature: {
      algorithm: "Ed25519",
      keyId,
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(resolutionHash), privateKey).toString("base64"),
    },
  };
  return validateCompatibilityResolution(value);
}

export function validateCompatibilityResolution(input: unknown): CompatibilityResolution {
  const root = record(input, "compatibility resolution");
  exactKeys(root, ["schemaVersion", "vigilVersion", "generatedAt", "component", "broken", "fixed", "relation", "limitations", "resolutionHash", "signature"], "compatibility resolution");
  if (root.schemaVersion !== COMPATIBILITY_RESOLUTION_SCHEMA) throw new Error(`resolution schemaVersion must be ${COMPATIBILITY_RESOLUTION_SCHEMA}`);
  if (root.relation !== "RESTORED_RECORDED_COMPATIBILITY") throw new Error("compatibility resolution relation is invalid");
  const component = record(root.component, "resolution component");
  exactKeys(component, ["ecosystem", "name"], "resolution component");
  const broken = record(root.broken, "resolution broken entry");
  exactKeys(broken, ["entryHash", "baselineVersion", "brokenVersion", "brokenArtifactSha256"], "resolution broken entry");
  const fixed = record(root.fixed, "resolution fixed entry");
  exactKeys(fixed, ["entryHash", "baselineVersion", "fixedVersion", "fixedArtifactSha256"], "resolution fixed entry");
  const signature = record(root.signature, "resolution signature");
  exactKeys(signature, ["algorithm", "keyId", "publicKey", "value"], "resolution signature");
  if (signature.algorithm !== "Ed25519") throw new Error("resolution signature algorithm must be Ed25519");
  if (!Array.isArray(root.limitations) || root.limitations.length < 1 || root.limitations.length > 8
    || root.limitations.some((item) => typeof item !== "string" || !item.length || item.length > 1_024)) {
    throw new Error("resolution limitations are invalid");
  }
  const value: CompatibilityResolution = {
    schemaVersion: COMPATIBILITY_RESOLUTION_SCHEMA,
    vigilVersion: text(root.vigilVersion, "resolution vigilVersion", 40),
    generatedAt: timestamp(root.generatedAt, "resolution generatedAt"),
    component: {
      ecosystem: text(component.ecosystem, "resolution component ecosystem", 80),
      name: text(component.name, "resolution component name", 160),
    },
    broken: {
      entryHash: sha256(broken.entryHash, "resolution broken entryHash"),
      baselineVersion: text(broken.baselineVersion, "resolution broken baselineVersion", 128),
      brokenVersion: text(broken.brokenVersion, "resolution broken version", 128),
      brokenArtifactSha256: sha256(broken.brokenArtifactSha256, "resolution broken artifact"),
    },
    fixed: {
      entryHash: sha256(fixed.entryHash, "resolution fixed entryHash"),
      baselineVersion: text(fixed.baselineVersion, "resolution fixed baselineVersion", 128),
      fixedVersion: text(fixed.fixedVersion, "resolution fixed version", 128),
      fixedArtifactSha256: sha256(fixed.fixedArtifactSha256, "resolution fixed artifact"),
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY",
    limitations: root.limitations as string[],
    resolutionHash: sha256(root.resolutionHash, "resolution hash"),
    signature: {
      algorithm: "Ed25519",
      keyId: sha256(signature.keyId, "resolution signature keyId"),
      publicKey: text(signature.publicKey, "resolution signature publicKey", 512),
      value: text(signature.value, "resolution signature value", 512),
    },
  };
  if (value.broken.baselineVersion !== value.fixed.baselineVersion) throw new Error("resolution baselines must match");
  if (value.broken.entryHash === value.fixed.entryHash
    || value.broken.brokenVersion === value.fixed.fixedVersion
    || value.broken.brokenArtifactSha256 === value.fixed.fixedArtifactSha256) {
    throw new Error("resolution fixed evidence must be distinct from broken evidence");
  }
  return value;
}

export function verifyCompatibilityResolution(value: CompatibilityResolution, publicKeyPath?: string): VerificationResult {
  const { resolutionHash: _hash, signature: _signature, ...unsigned } = value;
  const hashValid = hash(resolutionPayload(unsigned)) === value.resolutionHash;
  try {
    const embedded = createPublicKey({ key: Buffer.from(value.signature.publicKey, "base64"), type: "spki", format: "der" });
    const embeddedId = signingKeyId(publicKeyDer(embedded));
    const selected = publicKeyPath ? createPublicKey(readFileSync(publicKeyPath)) : embedded;
    const selectedId = signingKeyId(publicKeyDer(selected));
    const signatureValid = embeddedId === value.signature.keyId
      && selectedId === embeddedId
      && verify(null, Buffer.from(value.resolutionHash), selected, Buffer.from(value.signature.value, "base64"));
    return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
  } catch {
    return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  }
}

function registryPayload(value: Omit<CompatibilityRegistry, "registryHash">): string {
  return canonical(value);
}

export function createCompatibilityRegistry(entries: PublicCompatibilityEntry[], resolutions: CompatibilityResolution[]): CompatibilityRegistry {
  if (entries.length > 2_048) throw new Error("registry accepts at most 2048 compatibility entries");
  if (resolutions.length > 2_048) throw new Error("registry accepts at most 2048 resolution records");
  const orderedEntries = [...entries].sort((left, right) => left.entryHash.localeCompare(right.entryHash));
  const orderedResolutions = resolutions
    .map((resolution) => validateCompatibilityResolution(resolution))
    .sort((left, right) => left.resolutionHash.localeCompare(right.resolutionHash));
  if (new Set(orderedEntries.map((entry) => entry.entryHash)).size !== orderedEntries.length) throw new Error("registry contains duplicate compatibility entries");
  if (new Set(orderedResolutions.map((entry) => entry.resolutionHash)).size !== orderedResolutions.length) throw new Error("registry contains duplicate resolution records");
  const entryHashes = new Set(orderedEntries.map((entry) => entry.entryHash));
  const entriesByHash = new Map(orderedEntries.map((entry) => [entry.entryHash, entry]));
  for (const entry of orderedEntries) {
    const checked = verifyPublicCompatibilityEntry(entry);
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error("registry contains an invalid compatibility entry");
  }
  for (const resolution of orderedResolutions) {
    if (!entryHashes.has(resolution.broken.entryHash) || !entryHashes.has(resolution.fixed.entryHash)) {
      throw new Error("registry resolution references an entry that is not present");
    }
    const checked = verifyCompatibilityResolution(resolution);
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error("registry contains an invalid resolution record");
    const broken = entriesByHash.get(resolution.broken.entryHash)!;
    const fixed = entriesByHash.get(resolution.fixed.entryHash)!;
    // The v1 resolution record commits to entry hashes rather than duplicating
    // their timestamps, so chronology is revalidated after resolving both
    // independently signed entries.
    assertFixedEntryIsLater(broken, fixed);
    if (broken.verdict !== "CHANGED" || fixed.verdict !== "SAFE"
      || broken.signature.keyId !== fixed.signature.keyId || broken.signature.keyId !== resolution.signature.keyId
      || broken.component.ecosystem !== resolution.component.ecosystem || fixed.component.ecosystem !== resolution.component.ecosystem
      || broken.component.name !== resolution.component.name || fixed.component.name !== resolution.component.name
      || broken.component.currentVersion !== resolution.broken.baselineVersion
      || fixed.component.currentVersion !== resolution.fixed.baselineVersion
      || broken.component.currentArtifactSha256 !== fixed.component.currentArtifactSha256
      || broken.component.candidateVersion !== resolution.broken.brokenVersion
      || fixed.component.candidateVersion !== resolution.fixed.fixedVersion
      || broken.component.candidateArtifactSha256 !== resolution.broken.brokenArtifactSha256
      || fixed.component.candidateArtifactSha256 !== resolution.fixed.fixedArtifactSha256
      || !sameRunner(broken, fixed)) {
      throw new Error("registry resolution is inconsistent with its referenced exact-pair entries");
    }
  }
  const timestamps = [...orderedEntries.map((entry) => entry.generatedAt), ...orderedResolutions.map((item) => item.generatedAt)].sort();
  const value = {
    schemaVersion: COMPATIBILITY_REGISTRY_SCHEMA,
    generatedAt: timestamps.at(-1) ?? "1970-01-01T00:00:00.000Z",
    entries: orderedEntries,
    resolutions: orderedResolutions,
    summary: {
      entries: orderedEntries.length,
      safe: orderedEntries.filter((entry) => entry.verdict === "SAFE").length,
      changed: orderedEntries.filter((entry) => entry.verdict === "CHANGED").length,
      hold: orderedEntries.filter((entry) => entry.verdict === "HOLD").length,
      resolvedBreakages: orderedResolutions.length,
      components: new Set(orderedEntries.map((entry) => `${entry.component.ecosystem}:${entry.component.name}`)).size,
    },
  } satisfies Omit<CompatibilityRegistry, "registryHash">;
  return { ...value, registryHash: hash(registryPayload(value)) };
}

export function renderMaintainerEvidence(entry: PublicCompatibilityEntry): string {
  const checked = verifyPublicCompatibilityEntry(entry);
  if (!checked.hashValid || checked.signatureValid !== true) throw new Error("maintainer evidence requires a valid signed compatibility entry");
  const icon = entry.verdict === "SAFE" ? "✅" : entry.verdict === "CHANGED" ? "⚠️" : "⏸️";
  const observed = entry.verdict === "SAFE"
    ? "The recorded canaries produced matching PASS observations for the exact baseline and candidate artifacts."
    : entry.verdict === "CHANGED"
      ? "At least one recorded capability or canary observation changed for this exact version pair."
      : "The verifier withheld a compatibility ruling because required evidence or containment was incomplete.";
  const markdown = (value: string): string => html(value)
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", "\\u{000D}")
    .replaceAll("\n", "\\u{000A}");
  const changed = entry.changedCapabilities.length ? entry.changedCapabilities.map(markdown).join(", ") : "none observed";
  return `## ${icon} Agent update evidence: ${entry.verdict}\n\n`
    + `| Field | Bound evidence |\n|---|---|\n`
    + `| Component | <code>${markdown(entry.component.name)}</code> (<code>${markdown(entry.component.ecosystem)}</code>) |\n`
    + `| Version pair | <code>${markdown(entry.component.currentVersion)}</code> → <code>${markdown(entry.component.candidateVersion)}</code> |\n`
    + `| Exact artifacts | <code>${markdown(entry.component.currentArtifactSha256)}</code> → <code>${markdown(entry.component.candidateArtifactSha256)}</code> |\n`
    + `| Canary agreement | ${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length} |\n`
    + `| Changed capability classes | ${changed} |\n`
    + `| Signed entry | <code>${markdown(entry.entryHash)}</code> |\n`
    + `| Publisher key | <code>${markdown(entry.signature.keyId)}</code> |\n\n`
    + `${observed}\n\n`
    + `### What this does not prove\n\n${entry.limitations.map((item) => `- ${markdown(item)}`).join("\n")}\n\n`
    + `Verify locally with a pinned publisher key:\n\n`
    + "```sh\nvigil upgrade verify compatibility-entry.json --public-key publisher.pem\n```\n";
}

function html(value: string): string {
  return terminalSafe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function shortHash(value: string): string {
  return value.slice(7, 19);
}

export function renderCompatibilityRegistryPage(registry: CompatibilityRegistry): string {
  const resolvedByBroken = new Map(registry.resolutions.map((resolution) => [resolution.broken.entryHash, resolution]));
  const rows = [...registry.entries]
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
    .map((entry) => {
      const resolution = resolvedByBroken.get(entry.entryHash);
      const search = `${entry.component.name} ${entry.component.ecosystem} ${entry.component.currentVersion} ${entry.component.candidateVersion} ${entry.verdict} ${entry.changedCapabilities.join(" ")}`.toLowerCase();
      const anchor = `entry-${entry.entryHash.slice(7)}`;
      return `<tr data-proof-row data-search="${html(search)}"><td><a href="#${anchor}"><strong>${html(entry.component.name)}</strong></a><small>${html(entry.component.ecosystem)}</small></td><td>${html(entry.component.currentVersion)} → ${html(entry.component.candidateVersion)}</td><td><span class="status ${entry.verdict.toLowerCase()}">${html(entry.verdict)}</span>${resolution ? '<small class="restored">restored by a later verified pair</small>' : ""}</td><td>${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length}</td><td>${html(entry.changedCapabilities.join(", ") || "none observed")}</td><td><code>${html(shortHash(entry.entryHash))}</code></td></tr>`;
    }).join("\n");
  const details = [...registry.entries]
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
    .map((entry) => {
      const resolution = resolvedByBroken.get(entry.entryHash);
      return `<article id="entry-${entry.entryHash.slice(7)}" class="proof"><header><div><small>${html(entry.component.ecosystem)}</small><h2>${html(entry.component.name)}</h2></div><span class="status ${entry.verdict.toLowerCase()}">${html(entry.verdict)}</span></header><p><code>${html(entry.component.currentVersion)}</code> → <code>${html(entry.component.candidateVersion)}</code></p><dl><div><dt>Entry</dt><dd><code>${html(entry.entryHash)}</code></dd></div><div><dt>Publisher</dt><dd><code>${html(entry.signature.keyId)}</code></dd></div><div><dt>Runner</dt><dd><code>${html(entry.runner.imageDigest)}</code></dd></div><div><dt>Canary harness</dt><dd><code>${html(entry.runner.canaryHarnessSha256)}</code></dd></div></dl>${resolution ? `<p class="resolution">Recorded compatibility restored by <a href="#entry-${resolution.fixed.entryHash.slice(7)}">${html(resolution.fixed.fixedVersion)}</a>.</p>` : ""}<details><summary>Bounded claim</summary><ul>${entry.limitations.map((item) => `<li>${html(item)}</li>`).join("")}</ul></details></article>`;
    }).join("\n");
  const script = `(()=>{const q=document.querySelector('#proof-search');const rows=[...document.querySelectorAll('[data-proof-row]')];const count=document.querySelector('#visible-count');const apply=()=>{const value=q.value.trim().toLowerCase();let visible=0;for(const row of rows){const show=!value||row.dataset.search.includes(value);row.hidden=!show;if(show)visible++}count.textContent=String(visible)};q.addEventListener('input',apply);apply()})();`;
  const scriptHash = createHash("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>Agent compatibility proof registry</title><style>:root{font-family:ui-sans-serif,system-ui,sans-serif;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#e7eef8}main{max-width:1160px;margin:auto;padding:52px 24px}.eyebrow{color:#69e6a6;text-transform:uppercase;letter-spacing:.12em;font-weight:800}h1{font-size:clamp(2.2rem,6vw,4.8rem);letter-spacing:-.04em;line-height:1;margin:.25em 0}.lede{max-width:780px;color:#a9b8ca;font-size:1.1rem;line-height:1.65}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}.card,.proof,.table{border:1px solid #293a50;background:#0d1a2b;border-radius:18px}.card{padding:18px}.card strong{display:block;font-size:2rem}.search{display:flex;gap:12px;align-items:center;margin:24px 0}.search input{width:100%;padding:14px 16px;border:1px solid #3a4d66;border-radius:12px;background:#07111f;color:#fff;font:inherit}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:820px}th,td{text-align:left;padding:14px;border-bottom:1px solid #223349}th{font-size:.75rem;color:#91a6be;text-transform:uppercase;letter-spacing:.08em}td small{display:block;color:#8197b0;margin-top:4px}a{color:#b9d8ff}.status{font-weight:900}.safe{color:#69e6a6}.changed{color:#ffcb6b}.hold{color:#ff8e9b}.restored{color:#69e6a6}.proofs{display:grid;gap:18px;margin-top:40px}.proof{padding:22px;scroll-margin-top:20px}.proof header{display:flex;justify-content:space-between;gap:20px}.proof h2{margin:.2em 0}.proof dl{display:grid;gap:8px}.proof dl div{display:grid;grid-template-columns:130px 1fr;gap:12px}.proof dt{color:#8fa4bc}.proof dd{margin:0;overflow-wrap:anywhere}.resolution{border-left:3px solid #69e6a6;padding-left:12px}footer{margin-top:32px;color:#8499b0}@media(max-width:720px){main{padding:32px 16px}.cards{grid-template-columns:1fr 1fr}.proof dl div{grid-template-columns:1fr}.search{align-items:stretch;flex-direction:column}}</style></head><body><main><p class="eyebrow">Signed exact-pair evidence</p><h1>Agent compatibility proof registry</h1><p class="lede">Search privacy-minimized results for exact agent, skill, plugin, and MCP update pairs. SAFE is bounded to the recorded contained run. CHANGED means review the evidence before updating. HOLD means the verifier abstained.</p><section class="cards" aria-label="Registry summary"><div class="card"><strong>${registry.summary.entries}</strong>proof entries</div><div class="card"><strong>${registry.summary.changed}</strong>changed</div><div class="card"><strong>${registry.summary.resolvedBreakages}</strong>restored</div><div class="card"><strong>${registry.summary.components}</strong>components</div></section><label class="search" for="proof-search"><span>Search proofs</span><input id="proof-search" type="search" placeholder="component, version, verdict, capability"><small><span id="visible-count">${registry.entries.length}</span> shown</small></label><section class="table"><table><thead><tr><th>Component</th><th>Exact pair</th><th>Verdict</th><th>Matched</th><th>Changed surface</th><th>Commitment</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No signed entries supplied.</td></tr>'}</tbody></table></section><section class="proofs">${details}</section><footer>Registry <code>${html(registry.registryHash)}</code>. Each entry and resolution remains independently verifiable with a pinned publisher key. No repositories, prompts, commands, raw outputs, paths, or secrets are included.</footer></main><script>${script}</script></body></html>`;
}

export function renderBadgeEndpoint(entry: PublicCompatibilityEntry): string {
  const color = entry.verdict === "SAFE" ? "2ea66b" : entry.verdict === "CHANGED" ? "d38b16" : "b5475e";
  return `${JSON.stringify({ schemaVersion: 1, label: "agent update", message: entry.verdict.toLowerCase(), color }, null, 2)}\n`;
}

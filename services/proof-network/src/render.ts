import type { CompatibilityResolution, PublicCompatibilityEntry } from "./contracts";
import type { EntrySummary, ModerationState } from "./db";

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${html(title)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:1080px;margin:0 auto;padding:36px 20px;line-height:1.5;background:#07111f;color:#e7eef8}a{color:#74b9ff}code{overflow-wrap:anywhere;color:#c5d5e8}.muted{color:#9cadc1}.notice{padding:14px;border:1px solid #4b617a;border-radius:10px;background:#102035}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{padding:16px;border:1px solid #2e4057;border-radius:12px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:12px;border-bottom:1px solid #2e4057;vertical-align:top}input,select,button{font:inherit;padding:9px;margin:4px;background:#0e1b2a;color:#e7eef8;border:1px solid #40556e;border-radius:8px}.SAFE{color:#69e6a6}.CHANGED{color:#ffcb6b}.HOLD{color:#ff8e9b}@media(max-width:640px){.cards{grid-template-columns:1fr}}
</style></head><body>${body}</body></html>`;
}

export function renderSearchPage(entries: EntrySummary[], query: string): string {
  const counts = {
    safe: entries.filter((entry) => entry.verdict === "SAFE").length,
    changed: entries.filter((entry) => entry.verdict === "CHANGED").length,
    hold: entries.filter((entry) => entry.verdict === "HOLD").length,
  };
  const rows = entries.map((entry) => `<tr>
<td><a href="/proof/${encodeURIComponent(entry.entryHash)}">${html(entry.componentName)}</a><br><span class="muted">${html(entry.ecosystem)}</span></td>
<td><code>${html(entry.currentVersion)}</code> → <code>${html(entry.candidateVersion)}</code></td>
<td class="${entry.verdict}"><strong>${entry.verdict}</strong></td>
<td>${entry.resolutionHash === undefined ? "—" : `<a href="/resolution/${encodeURIComponent(entry.resolutionHash)}">verified fixed record</a>`}</td>
<td><time datetime="${html(entry.generatedAt)}">${html(entry.generatedAt.slice(0, 10))}</time></td>
</tr>`).join("");
  return page("Agent compatibility proof network", `<main>
<h1>Agent compatibility proof network</h1>
<p class="notice">Signed, privacy-minimized evidence for exact version pairs. <strong>SAFE is bounded to the recorded artifacts, canaries, and contained runner.</strong> It is not a universal safety claim.</p>
<form method="get" action="/" role="search"><label>Search public component <input name="q" maxlength="160" value="${html(query)}"></label><button type="submit">Search</button></form>
<section class="cards" aria-label="Results"><div class="card"><strong>${counts.safe}</strong><br>SAFE</div><div class="card"><strong>${counts.changed}</strong><br>CHANGED</div><div class="card"><strong>${counts.hold}</strong><br>HOLD</div></section>
<div class="table"><table><thead><tr><th>Component</th><th>Exact pair</th><th>Verdict</th><th>Resolution</th><th>Observed</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No active signed records matched.</td></tr>'}</tbody></table></div>
<p class="muted">The network stores signed public entries, signer status, append-only correction state, and minimal opt-in lifecycle counters. It does not receive source, prompts, transcripts, paths, arguments, environment variables, secrets, private names, or full receipts.</p>
</main>`);
}

export function renderProofPage(
  entry: PublicCompatibilityEntry,
  resolution?: CompatibilityResolution,
  correction?: ModerationState,
): string {
  const canaryRows = entry.canaries.map((canary) => `<tr><td>${html(canary.publicId ?? canary.idSha256)}</td><td>${canary.current}</td><td>${canary.candidate}</td><td>${canary.matched ? "matched" : "changed"}</td></tr>`).join("");
  const resolutionBlock = resolution === undefined ? "" : `<section class="notice"><h2>Verified fixed version recorded</h2><p>This broken exact pair is linked to fixed version <code>${html(resolution.fixed.fixedVersion)}</code> by signed record <a href="/resolution/${encodeURIComponent(resolution.resolutionHash)}"><code>${html(resolution.resolutionHash)}</code></a>.</p></section>`;
  const correctionBlock = correction?.action !== "CORRECT" ? "" : `<section class="notice"><h2>Correction</h2><p>This record has an append-only correction pointer${correction.replacement_hash === null ? "." : ` to <a href="/proof/${encodeURIComponent(correction.replacement_hash)}"><code>${html(correction.replacement_hash)}</code></a>`}.</p></section>`;
  return page(`${entry.component.name} compatibility ${entry.verdict}`, `<main>
<p><a href="/">← Search records</a></p>
<h1>${html(entry.component.name)} <span class="${entry.verdict}">${entry.verdict}</span></h1>
<p><code>${html(entry.component.currentVersion)}</code> → <code>${html(entry.component.candidateVersion)}</code> · ${html(entry.component.ecosystem)}</p>
${correctionBlock}${resolutionBlock}
<dl><dt>Entry commitment</dt><dd><code>${html(entry.entryHash)}</code></dd><dt>Publisher key</dt><dd><code>${html(entry.signature.keyId)}</code></dd><dt>Current artifact</dt><dd><code>${html(entry.component.currentArtifactSha256)}</code></dd><dt>Candidate artifact</dt><dd><code>${html(entry.component.candidateArtifactSha256)}</code></dd><dt>Runner image</dt><dd><code>${html(entry.runner.imageDigest)}</code></dd><dt>Configuration</dt><dd><code>${html(entry.runner.configSha256)}</code></dd></dl>
<h2>Recorded canaries</h2><div class="table"><table><thead><tr><th>Public or pseudonymous ID</th><th>Baseline</th><th>Candidate</th><th>Comparison</th></tr></thead><tbody>${canaryRows || '<tr><td colspan="4">No public canary detail.</td></tr>'}</tbody></table></div>
<h2>Changed capability classes</h2><p>${entry.changedCapabilities.length === 0 ? "None observed." : entry.changedCapabilities.map(html).join(", ")}</p>
<h2>Limits</h2><ul>${entry.limitations.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
<p><a href="/api/v1/entries/${encodeURIComponent(entry.entryHash)}">Signed JSON API record</a> · <a href="/api/v1/badges/${encodeURIComponent(entry.entryHash)}">Badge endpoint</a></p>
</main>`);
}

export function renderResolutionPage(resolution: CompatibilityResolution): string {
  return page(`${resolution.component.name} fixed-version evidence`, `<main>
<p><a href="/">← Search records</a></p><h1>Recorded compatibility restoration</h1>
<p><strong>${html(resolution.component.name)}</strong> (${html(resolution.component.ecosystem)})</p>
<p><a href="/proof/${encodeURIComponent(resolution.broken.entryHash)}"><code>${html(resolution.broken.brokenVersion)}</code> CHANGED</a> → <a href="/proof/${encodeURIComponent(resolution.fixed.entryHash)}"><code>${html(resolution.fixed.fixedVersion)}</code> SAFE</a></p>
<p class="notice">This relation means the later signed entry restored the recorded baseline canary behavior under the same runner and commitments. It does not prove universal correctness.</p>
<dl><dt>Resolution commitment</dt><dd><code>${html(resolution.resolutionHash)}</code></dd><dt>Publisher key</dt><dd><code>${html(resolution.signature.keyId)}</code></dd><dt>Exact broken artifact</dt><dd><code>${html(resolution.broken.brokenArtifactSha256)}</code></dd><dt>Exact fixed artifact</dt><dd><code>${html(resolution.fixed.fixedArtifactSha256)}</code></dd></dl>
<h2>Limits</h2><ul>${resolution.limitations.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
<p><a href="/api/v1/resolutions/${encodeURIComponent(resolution.resolutionHash)}">Signed JSON API record</a></p>
</main>`);
}

export function badgePayload(entry: PublicCompatibilityEntry, proofUrl: string): Record<string, string | number> {
  const color = entry.verdict === "SAFE" ? "2ea44f" : entry.verdict === "CHANGED" ? "d29922" : "cf222e";
  return {
    schemaVersion: 1,
    label: "agent update",
    message: entry.verdict.toLowerCase(),
    color,
    namedLogo: "githubactions",
    cacheSeconds: 300,
    link: proofUrl,
  };
}

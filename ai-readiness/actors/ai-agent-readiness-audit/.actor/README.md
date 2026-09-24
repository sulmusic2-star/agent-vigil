# AI Agent Readiness Audit

Score how ready a website is for **AI search and AI agents**, from 0 to 100, with a ranked list of fixes. One run can audit one site or thousands.

AI assistants now read, cite and act on websites: they answer from them, follow their links, and, with **WebMCP** (a W3C draft that lets a page offer tools to AI agents), fill in forms and take actions. This audit shows what those agents see on a site today and what to fix first.

## What it checks

| Area | Points | What is checked |
|---|---|---|
| AI access and policy | 20 | robots.txt health (RFC 9309), an explicit AI policy (AI crawler rules, Content Signals or TDMRep), and whether AI search and assistant crawlers may fetch the site |
| Crawler reach | 20 | what AI crawlers actually get: whether a firewall or CDN blocks AI crawlers that robots.txt allows, whether the homepage's content is in the HTML (most AI crawlers don't run JavaScript), and whether a Markdown version is offered |
| llms.txt | 10 | `/llms.txt` present and valid per llmstxt.org, a summary, link sections, and `/llms-full.txt` |
| Structured data | 25 | schema.org JSON-LD on the homepage, Organization/WebSite entities, JSON-LD syntax errors, title, meta description and canonical link |
| Agent actions | 15 | HTTPS (required for WebMCP), WebMCP tools declared in forms (`toolname`, `tooldescription`) or registered in scripts (`document.modelContext.registerTool`), and tool description quality |
| Discovery and rights | 10 | sitemap, A2A agent card (`/.well-known/agent-card.json`), and machine-readable AI usage rights (Content Signals, RSL licenses, TDMRep) |

The weights follow what AI systems are known to use: content they can fetch and read counts most, and llms.txt, which few AI crawlers request today, counts least.

Each result includes a **grade** (A–F), a one-line **summary**, the **top fix**, and up to six **ranked fixes**, each with the points it would add.

The score measures reachability and machine-readability for AI agents. It does not judge a site's policy: blocking AI crawlers is a valid choice, and it lowers the score only because it makes the site less visible in AI answers.

## Input

```json
{
  "websites": ["shopify.com", "github.com"],
  "scanScripts": true,
  "testCrawlerReach": true,
  "monitorChanges": false
}
```

## Output (one item per website, shortened)

```json
{
  "url": "https://shop.example/",
  "finalUrl": "https://www.shop.example/",
  "score": 74,
  "grade": "B",
  "summary": "Blocks AI training, allows AI search and assistants; firewall turns away PerplexityBot; llms.txt valid; no WebMCP tools",
  "topFix": "Expose key actions (search, booking, contact) to AI agents as WebMCP tools: add toolname and tooldescription attributes to the form",
  "fixes": [
    { "priority": 1, "area": "Agent actions", "action": "Expose key actions … as WebMCP tools …", "pointsAvailable": 10 },
    { "priority": 2, "area": "Structured data", "action": "Add Organization and WebSite JSON-LD so AI answers can identify your brand", "pointsAvailable": 7 }
  ],
  "areas": { "AI access and policy": { "earned": 25, "possible": 25 }, "llms.txt": { "earned": 18, "possible": 20 } },
  "aiAccess": { "policy": "blocks-training", "agents": [ … ] },
  "llmsTxt": { "present": true, "valid": true, "linkCount": 31 },
  "webmcp": { "secureContext": true, "declarativeTools": [], "imperativeApiDetected": false },
  "crawlerReach": {
    "summary": "Cloudflare or the site's firewall turns away PerplexityBot, although robots.txt allows them",
    "contentWithoutJavaScript": { "status": "ok", "textChars": 4520 },
    "firewall": { "edgeProvider": "Cloudflare", "turnedAway": ["PerplexityBot"], "inconclusive": false },
    "markdown": { "acceptHeader": false, "alternateLink": false }
  },
  "structuredData": { "types": ["WebSite"], "entities": 1, "parseErrors": 0 },
  "discovery": { "a2aAgentCard": { "present": false, "note": "HTTP 404" } },
  "sitemapFound": true
}
```

## Monitor on a schedule

Turn on **Report changes since the last run** and schedule weekly. Each result then lists what changed, for example `score: 62 → 71`, `webmcpTools: 0 → 2`, or `turnedAway: [] → ["ClaudeBot"]` when a firewall change starts blocking an AI crawler.

## Polite by default

The audit reads files that sites publish for automated readers (robots.txt, llms.txt, sitemaps, `/.well-known`). It fetches the homepage and same-site scripts only when robots.txt allows the `AIReadinessAudit` token. The crawler reach test imitates only AI crawlers that robots.txt allows, and each of those requests also names this tool. If it may not fetch the homepage, the score covers what it could check and is marked `partialScore: true`.

If the homepage redirects, for example from `example.com` to `www.example.com`, the audit checks the site it lands on and reports that address as `finalUrl`.

## Pricing

You pay per website audited. Sites that don't respond are **not** charged. See the Pricing tab for the current price.

## Good to know

- WebMCP tools registered by JavaScript exist only after scripts run. The audit reports script **evidence** of the API and any tool names written as literals, not a complete list.
- The score reflects public best practices as of September 2026, not an official standard.
- Need details for one area? Use the focused Actors: **AI Crawler Access Checker**, **llms.txt Validator**, **llms.txt Generator**, **Product Schema Checker for AI Shopping**.

# AI Crawler Access Checker

See, for any list of websites, which AI crawlers each site allows or blocks, both **in robots.txt** and **in practice**: **GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Applebot-Extended, Meta-ExternalAgent, Bytespider** and more. Check one site or thousands in one run.

## Declared versus actual access

A robots.txt that welcomes AI crawlers doesn't mean they get in. Firewalls, CDNs and bot-protection settings often block or challenge AI crawlers the site owner meant to allow. That quietly keeps the site out of ChatGPT, Claude and Perplexity answers.

For each site, the checker fetches the homepage as a normal browser and as each AI crawler that robots.txt allows, then reports:

- crawlers that get **blocked** (for example HTTP 403) or **challenged** (a bot-check page) although robots.txt allows them
- crawlers that get a **much shorter page** than browsers do
- the likely **CDN or firewall** in front of the site (Cloudflare, Akamai, Imperva, DataDome, Fastly and others), with the setting to check
- **RSL licenses** (`License:` lines in robots.txt or `<link rel="license">`), the standard for licensing content to AI companies

Crawlers that robots.txt disallows are never imitated. Each test request also names this tool in its user agent.

## What you get for each website

- **A plain-language AI policy**, for example *"Blocks AI training, allows AI search and assistants"*.
- **A row for every AI crawler**: allowed, limited or blocked, with the exact robots.txt rule that decided it.
- **Counts** of blocked training crawlers and blocked AI search/assistant crawlers.
- **Content Signals** (`Content-Signal: search=yes, ai-train=no`) declared in robots.txt.
- **TDMRep** text-and-data-mining reservation (`/.well-known/tdmrep.json`, header or meta tag), used for EU copyright opt-outs.
- **Page-level tags**: `noai`, `noimageai`, `noindex` and `nosnippet` from meta robots and `X-Robots-Tag`.
- Whether the site blocks **all** bots, and whether it has **AI-specific** rules at all.

Crawlers are grouped by purpose: **training** (collects content for model training), **search** (indexes for AI answers), **user** (fetches when a person asks an assistant) and **other**.

## Who uses it

- **SEO and AI-search (GEO) agencies** finding clients whose firewall silently blocks AI search crawlers, before any other AI visibility work.
- **Publishers** checking that the crawlers they block are really blocked and the ones they allow really get in, across all their sites.
- **Data and AI teams** checking that sources permit AI use before collecting.
- **Site owners** confirming their robots.txt and firewall say what they meant.

## Input

```json
{
  "websites": ["nytimes.com", "wikipedia.org", "github.com"],
  "checkPageDirectives": true,
  "testFirewallAccess": true,
  "monitorChanges": false
}
```

Domains or full URLs both work. Each site is checked at its homepage origin.

## Output (one item per website)

```json
{
  "url": "https://shop.example/",
  "policy": "mostly-blocks-training",
  "policySummary": "Mostly blocks AI training, mostly allows AI search; declares ai-train=no, search=yes",
  "actualAccessSummary": "Cloudflare or the site's firewall turns away PerplexityBot, although robots.txt allows them",
  "actualAccess": {
    "edgeProvider": "Cloudflare",
    "turnedAway": ["PerplexityBot"],
    "fix": "Let PerplexityBot through: in Cloudflare, check AI Crawl Control and bot settings (such as blocking AI bots or Bot Fight Mode) and allow the AI crawlers you want"
  },
  "rslLicenses": [],
  "trainingCrawlersBlocked": "6/10",
  "searchAndAssistantCrawlersBlocked": "0/9",
  "blocksAllBots": false,
  "hasAiSpecificRules": true,
  "contentSignals": { "search": "yes", "ai-train": "no" },
  "tdmReservation": null,
  "agents": [
    { "agent": "GPTBot", "vendor": "OpenAI", "purpose": "training", "status": "blocked",
      "matchedGroup": "GPTBot", "decidingRule": "Disallow: /" },
    { "agent": "OAI-SearchBot", "vendor": "OpenAI", "purpose": "search", "status": "allowed",
      "matchedGroup": "*", "decidingRule": "Allow: /" }
  ]
}
```

## How it decides

robots.txt is parsed per **RFC 9309**: an agent uses its own group if one names it, otherwise the `*` group; the longest matching rule wins; `Allow` wins a tie; `*` and `$` wildcards are supported. If robots.txt returns a server error, compliant crawlers must treat the whole site as off-limits, and the report says so. An HTML page served at `/robots.txt` (a common single-page-app mistake) is flagged.

## Monitor changes on a schedule

Turn on **Report changes since the last run** and schedule the Actor weekly. Each result then includes a `changes` list, for example `agents.GPTBot: allowed → blocked` or `turnedAway: [] → ["ClaudeBot"]` when a firewall change starts blocking a crawler.

## Pricing

You pay per website checked. Sites that don't respond and invalid entries are **not** charged; they are listed in the run's `OUTPUT` record instead. See the Pricing tab for the current price.

## Good to know

- The AI crawler list is maintained by hand and covers the major crawlers; add others with **Extra user-agent tokens**.
- Some tokens, such as Google-Extended and Applebot-Extended, are control tokens: blocking them limits AI use, not search indexing.
- The firewall test sends requests with each crawler's user agent from this tool's servers. Sites that verify real crawlers by IP address may treat the real crawlers differently, so a block is a strong hint, not proof. A site that blocks normal browser requests too is reported as inconclusive.
- It does not tell you what any crawler actually does with your content, and it is not legal advice.
- It reads robots.txt and `/.well-known` files, and fetches the homepage only when robots.txt allows the `AIReadinessAudit` token.

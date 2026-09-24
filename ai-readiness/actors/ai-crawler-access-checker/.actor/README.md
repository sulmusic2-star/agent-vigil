# AI Crawler Access Checker

See, for any list of websites, which AI crawlers each site allows or blocks: **GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, Applebot-Extended, Meta-ExternalAgent, Bytespider** and more. Check one site or thousands in one run.

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

- **SEO and AI-search (GEO) agencies** auditing client sites before AI visibility work.
- **Publishers and researchers** tracking how sites respond to AI crawlers.
- **Data and AI teams** checking that sources permit AI use before collecting.
- **Site owners** confirming their robots.txt says what they meant.

## Input

```json
{
  "websites": ["nytimes.com", "wikipedia.org", "github.com"],
  "checkPageDirectives": true,
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

Turn on **Report changes since the last run** and schedule the Actor weekly. Each result then includes a `changes` list, for example `agents.GPTBot: allowed → blocked`.

## Pricing

You pay per website checked. Sites that don't respond and invalid entries are **not** charged; they are listed in the run's `OUTPUT` record instead. See the Pricing tab for the current price.

## Good to know

- The AI crawler list is maintained by hand and covers the major crawlers; add others with **Extra user-agent tokens**.
- Some tokens, such as Google-Extended and Applebot-Extended, are control tokens: blocking them limits AI use, not search indexing.
- This tool reports what sites declare. It does not tell you what any crawler actually does, and it is not legal advice.
- It reads robots.txt and `/.well-known` files, and fetches the homepage only when robots.txt allows the `AIReadinessAudit` token.

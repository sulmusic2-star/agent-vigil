# llms.txt Generator

Generate a ready-to-publish **llms.txt** for any website in one run. llms.txt is a short Markdown file at `/llms.txt` that tells AI assistants and agents what a site is and which pages matter most ([llmstxt.org](https://llmstxt.org)).

## How it works

1. Follows the homepage to the site visitors actually land on (for example `example.com` to `www.example.com`).
2. Collects pages from the **homepage links** first, since those are the pages the site puts in front of visitors, then from the **sitemap** (robots.txt `Sitemap:` lines or `/sitemap.xml`, including sitemap indexes and gzipped sitemaps).
3. Leaves out pages that don't belong in an llms.txt: sign-in, account, cart and checkout pages, search results, feeds, URLs with query strings, and pages on other sites.
4. Picks up to your **Maximum pages** setting and reads each page's title and meta description.
5. Writes an llms.txt with:
   - the site name as the `# Title`
   - the homepage description as the `> summary`
   - `## Main pages` for the homepage and top-level pages, then one `## Section` per folder with two or more pages (Blog, Docs and so on), each a list of `- [Page title](url): description`
   - page titles without the repeated `| Site name` suffix, and no description that just repeats the site summary
   - an `## Optional` section for pages beyond the per-section limit
6. **Validates** the result against the llmstxt.org format before saving it.

## What you get

- A dataset item per website with the full `llmsTxt` text, the number of pages included, and whether the site already has an llms.txt.
- A **downloadable file** for each site in the run's key-value store (for example `llms-example.com.txt`), ready to upload to your site's root.

## Input

```json
{
  "websites": ["www.python.org"],
  "maxPages": 40
}
```

## Output (one item per website)

```json
{
  "url": "https://shop.example/",
  "finalUrl": "https://www.shop.example/",
  "pagesIncluded": 24,
  "draftValid": true,
  "existingLlmsTxt": false,
  "llmsTxtFileKey": "llms-shop.example.txt",
  "llmsTxt": "# Shop Example\n\n> Trail running shoes and gear.\n\n## Main pages\n\n- [Home](https://www.shop.example/)\n- [Pricing](https://www.shop.example/pricing): Plans for every runner\n\n## Shoes\n\n- [Trail Runner X](https://www.shop.example/shoes/trail-runner-x): Lightweight trail shoe\n- [Road Runner](https://www.shop.example/shoes/road-runner): Cushioned road shoe\n"
}
```

Review the draft before publishing: reorder sections, drop pages you don't want agents to focus on, and add a line or two of context under the summary.

## Polite by default

The generator reads sitemaps and robots.txt directly, and fetches HTML pages only when robots.txt allows the `AIReadinessAudit` token (falling back to `*`). Pages it may not fetch are left out.

## Pricing

You pay per website generated. Sites that don't respond are **not** charged. See the Pricing tab for the current price.

## Related

Check existing files with the **llms.txt Validator** Actor, or run the full **AI Agent Readiness Audit**.

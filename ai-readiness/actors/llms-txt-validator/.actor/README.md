# llms.txt Validator

Check whether websites publish a valid **llms.txt**, the Markdown file that tells AI assistants and agents what a site is about and which pages matter ([llmstxt.org](https://llmstxt.org)). Validate one site or a whole list in one run.

## What it checks

- **Present?** Fetches `/llms.txt` and catches the most common mistake: a site that answers every URL with its HTML homepage, so `/llms.txt` "exists" but is really a web page.
- **Structure**, per the llmstxt.org format:
  - starts with a single `# Title` (required)
  - a `> one-line summary` under the title
  - `## Section` headings, each followed by a list of links like `- [Name](https://…): notes`
  - no deeper headings, no loose text inside sections, no malformed or duplicate links
- **Relative links**, which some agents cannot resolve.
- An **Optional** section, which agents may skip for shorter context.
- **Size**: flags files over 100 KB, since llms.txt should stay concise.
- Whether **`/llms-full.txt`** is also published.

Every issue is labeled `error`, `warning` or `info`. A problem that repeats is reported once, with how many times it occurs and the first line numbers, so a large file gives a short list you can act on.

Common real-world variations, such as `### subheadings` or notes written as `- [Name](url) - notes`, are reported as `info`. Agents can still read those files.

## Input

```json
{
  "websites": ["docs.anthropic.com", "docs.stripe.com", "github.com"],
  "monitorChanges": false
}
```

## Output (one item per website)

```json
{
  "url": "https://docs.example.com/",
  "llmsTxtUrl": "https://docs.example.com/llms.txt",
  "present": true,
  "valid": true,
  "errors": 0,
  "warnings": 1,
  "title": "Example Docs",
  "summary": "Guides and API reference for Example.",
  "sectionCount": 3,
  "linkCount": 42,
  "issues": [
    { "severity": "warning", "message": "2 duplicate link(s), for example https://docs.example.com/auth",
      "count": 2, "lines": [18, 40] }
  ],
  "llmsFullTxt": true
}
```

## Monitor on a schedule

Turn on **Report changes since the last run** and schedule it weekly to catch an llms.txt that breaks after a deploy. Results then include a `changes` list, for example `valid: true → false`.

## Need to create one?

Use the companion **llms.txt Generator** Actor to build a valid llms.txt from a site's sitemap.

## Pricing

You pay per website checked. Sites that don't respond and invalid entries are **not** charged. See the Pricing tab for the current price.

# AI Product Recommendation Tracker

Ask **ChatGPT, Perplexity, Gemini and Claude** the questions your shoppers ask (for example *"best running shoes for flat feet"*) and see **which products and brands they recommend**, **how often your brand appears**, **at what position**, and **which websites they cite**. Each assistant is asked several times with live web search, because AI answers change from one ask to the next.

## Why

Shoppers now ask AI assistants what to buy: about 50 million shopping questions a day go to ChatGPT alone. The assistants name a handful of products, often from a handful of review sites. If yours isn't named, you don't find out, because nothing shows up in your analytics. This Actor measures it.

## What you get for each question

- **Most recommended products and brands**, ranked by the share of answers that list them, with the assistants that named each one and its best and average position in their lists.
- **Your brands' visibility**: for every name you track, how many answers mention it, how many list it, its best position, and a breakdown per assistant (for example `ChatGPT 2/2, Perplexity 0/2`).
- **The sites the AI cites**, counted across answers. These are the review sites and retailers to get featured on.
- **Per-assistant detail**: each assistant's own ranking, sources, and any errors.
- **The answers themselves** (first 4,000 characters each) with their sources, so you can read what shoppers read.
- A one-line **summary**, for example *"6 answers from ChatGPT, Perplexity and Gemini. Most recommended: Brooks Adrenaline GTS 24 (5 of 6). Brooks: in 5 of 6, best position 1."*

## How it works

1. Each question goes to each selected assistant through its official API with web search turned on: OpenAI's Responses API with web search, Perplexity's Sonar API, the Gemini API with Grounding with Google Search, and Anthropic's API with web search.
2. Each assistant is asked **Answers per assistant** times (2 by default).
3. The recommended names are read from each answer's list (numbered or bulleted items, bold names or one heading per pick). Sub-bullets such as price or pros are ignored, and near-identical names are merged (*"Brooks Ghost 16 Running Shoe"* counts as *"Brooks Ghost 16"*).
4. Results are ranked by the share of answers that list each name.

**Reusing this week's answers.** Answers are kept for the rest of the ISO week (UTC). When the same question with the same location is asked again that week, the saved answers are reused, and everyone who asks gets the same measurement. Turn off **Reuse answers from this week** to force new answers. Either way you pay the same per answer.

**How close is this to the apps?** The APIs use the same model families and live search as the consumer apps, but not the apps' memory, personalization or shopping widgets. Treat the results as a consistent, repeatable measurement of what each assistant recommends, not a copy of one person's screen.

## Input

```json
{
  "questions": ["best running shoes for flat feet", "best robot vacuum for pet hair"],
  "brands": ["Brooks", "ASICS", "Roborock"],
  "engines": ["chatgpt", "perplexity", "gemini"],
  "samplesPerEngine": 2,
  "country": "US"
}
```

Add `"claude"` to `engines` to ask Claude too. `city` (optional) sets a city for local questions; ChatGPT and Claude use it.

## Output (one item per question)

```json
{
  "question": "best running shoes for flat feet",
  "summary": "6 answers from ChatGPT, Perplexity and Gemini. Most recommended: Brooks Adrenaline GTS 24 (5 of 6). Brooks: in 5 of 6, best position 1. ASICS: in 3 of 6, best position 2.",
  "topRecommendation": "Brooks Adrenaline GTS 24",
  "topRecommendations": [
    {"name": "Brooks Adrenaline GTS 24", "answers": 5, "share": 0.833, "engines": ["ChatGPT", "Perplexity", "Gemini"], "bestRank": 1, "averageRank": 1.2},
    {"name": "ASICS Gel-Kayano 31", "answers": 3, "share": 0.5, "engines": ["ChatGPT", "Gemini"], "bestRank": 2, "averageRank": 2.3}
  ],
  "brands": [
    {"brand": "Brooks", "mentionedIn": 5, "share": 0.833, "listedIn": 5, "bestRank": 1, "byEngine": {"ChatGPT": "2/2", "Perplexity": "1/2", "Gemini": "2/2"}}
  ],
  "topSources": [{"domain": "runnersworld.com", "citations": 4, "engines": ["ChatGPT", "Gemini"]}],
  "answers": {"total": 6, "new": 6, "reused": 0, "failed": 0},
  "engines": [{"engine": "chatgpt", "label": "ChatGPT", "model": "gpt-5-mini", "answers": 2, "recommendations": ["..."], "topSources": ["..."]}],
  "answerTexts": [{"engine": "ChatGPT", "sample": 1, "reused": false, "text": "...", "sources": ["https://..."]}]
}
```

The dataset has two views: **Overview** (one row per question) and **Recommendations** (one row per product per question), both exportable to CSV, Excel or JSON.

## Pricing

Pay per event:

- **One AI answer**, per assistant (`chatgpt-answer`, `perplexity-answer`, `gemini-answer`, `claude-answer`). Charged for every answer used in a result, new or reused.
- **One saved question** (a small fee per result).

Questions that no assistant could answer are not saved and not charged. The run stops starting new questions at your spending limit.

## Tips

- **Track weekly.** Schedule the Actor with the same questions to follow your share of AI recommendations over time.
- **Use the questions shoppers really ask:** "best X for Y", "X vs Y", "is X worth it", "cheapest X that does Y".
- **Act on the sources.** The most-cited sites are where the AI learns what to recommend. Getting reviewed or listed there is the most direct way to be recommended.
- **Pair it with the AI Agent Readiness Audit** to check that AI crawlers can actually read your product pages.

## FAQ

**Do I need my own API keys?** No. The Actor uses its own keys for all four assistants.

**Why do results differ between runs?** AI answers vary. That is why each assistant is asked several times and results are shown as shares. Raise **Answers per assistant** for steadier numbers.

**Does it follow each app's personalization?** No. Every ask is a fresh, signed-out-style question with the location you set.

# Go live on Apify Store

These steps need you: they involve your identity, your money or a click that publishes under your name. Plan on about an hour and a half the first time. Everything else is already done: the five Actors are built, tested and documented, and they have Store pages, icons and prices.

## Your checklist

1. **Put the code on `main`.** Open <https://github.com/sulmusic2-star/agent-vigil/compare/main...claude/amazing-babbage-ktqwpx>, select **Create pull request**, then **Merge pull request**. (Or ask Claude to open the pull request.) Apify builds each Actor from `main`.
2. **Create a free Apify account** at <https://console.apify.com/sign-up>. Your username appears in every Store link (`apify.com/<username>/ai-agent-readiness-audit`), so pick a short, brand-like name.
3. **Create the five Actors.** For each row in [the Actor table](#the-five-actors):
   1. Go to **Development** > **My Actors** and create a new Actor.
   2. On its **Source** tab, set **Source type** to **Git repository** and paste the Git URL from the table. The repository is public, so no deploy key is needed.
   3. Select **Build**. The build takes about a minute.
   4. Select **Start** with the prefilled input. When the run finishes, the **Output** tab should show results. If it shows none, stop here and tell Claude.
4. **Set up payouts (once).** In any Actor's **Publishing** tab, under **Monetization**, enter your billing details and a payout method. PayPal or Wise pays out from $20; other methods from $100. Then verify your identity under **Development** > **Insights** > **Payouts**. Apify pays monthly: invoices are created on the 11th for the previous month.
5. **Price each Actor.** In **Publishing** > **Monetization**, select **Set up monetization**, choose pay per event, and then:
   - Keep `apify-actor-start` at Apify's default price.
   - Set `apify-default-dataset-item` to the price in the table, with the event title from the table. It charges once per result. Sites that don't respond and invalid inputs aren't saved, so they aren't charged.
   - Choose `apify-default-dataset-item` as the primary event, then confirm.
6. **Publish each Actor.** In **Publishing**:
   - **Display information:** upload the icon from `ai-readiness/store-assets/icons/` (PNG), pick the suggested categories (or the closest ones Apify offers) and paste the SEO title and description from [Store listing text](#store-listing-text).
   - **Sample output:** use the run from step 3.
   - **Actor permissions:** keep **Limited permissions**. The Actors need nothing more.
   - Select **Publish on Store**.

After that the Actors run without you. Apify tests each one daily with its prefilled input and emails you if one fails three days in a row. Forward that email to Claude.

## The five Actors

Git URL prefix for every Actor: `https://github.com/sulmusic2-star/agent-vigil#main:ai-readiness/actors/`

| Actor | Git URL ends with | Price per result | Per 1,000 | Event title |
|---|---|---|---|---|
| AI Agent Readiness Audit | `ai-agent-readiness-audit` | $0.02 | $20 | Website audited |
| llms.txt Generator | `llms-txt-generator` | $0.05 | $50 | llms.txt generated |
| AI Crawler Access Checker | `ai-crawler-access-checker` | $0.004 | $4 | Website checked |
| llms.txt Validator | `llms-txt-validator` | $0.003 | $3 | Website checked |
| Product Schema Checker for AI Shopping | `product-schema-checker` | $0.003 | $3 | Product page checked |

**Why these prices.** Apify's platform costs for one result are well under a cent: a few seconds of a 512 MB container at $0.20 per GB-hour, plus 1–10 MB of traffic at $0.20 per GB. You keep 80% of what users pay, minus those costs. The two cheap checkers are for people who check thousands of sites. The audit and the generator give one finished report or file per site, so they cost more.

**Changing prices later.** Lowering a price takes effect at once. Raising one takes effect after 14 days if the Actor has paying users, and you can make one such change per Actor per month.

## Store listing text

| Actor | Suggested categories | SEO title | SEO description |
|---|---|---|---|
| AI Agent Readiness Audit | SEO tools, AI | AI Readiness Audit: Score Any Website for AI Agents | Score websites 0–100 for AI search and AI agents: AI crawler access, llms.txt, WebMCP tools, structured data and discovery files, with ranked fixes. |
| llms.txt Generator | SEO tools, Developer tools | llms.txt Generator: Create llms.txt for Any Website | Generate a valid, ready-to-publish llms.txt for any website from its homepage links, sitemap and page titles. Bulk runs, downloadable files. |
| AI Crawler Access Checker | SEO tools, AI | AI Crawler Checker: GPTBot, ClaudeBot, robots.txt | See which AI crawlers each website allows or blocks, including GPTBot, ClaudeBot, Google-Extended and PerplexityBot, with the exact robots.txt rule. |
| llms.txt Validator | SEO tools, Developer tools | llms.txt Validator: Check llms.txt Files in Bulk | Check whether websites publish a valid llms.txt per llmstxt.org: structure, links, summary, size and llms-full.txt. One site or thousands. |
| Product Schema Checker for AI Shopping | E-commerce, SEO tools | Product Schema Checker for AI Shopping Agents | Score product pages on the schema.org Product data AI shopping assistants use: price, availability, GTIN, brand, reviews, shipping and returns. |

The title, short description and full Store page of each Actor come from its `.actor/actor.json` and `.actor/README.md`, so they are already filled in.

## What to expect

Store income builds slowly. Most new Actors earn little in their first months, and income grows with good reviews, successful runs and time in the Store's search results. These are a bet on a growing need, not a guaranteed income.

Two things help most once the Actors are live:

- **Use the Actors to make public data.** For example: check the 1,000 most popular websites for AI crawler rules and llms.txt, and post the findings with a link to the Actors. Posts like this bring people who need the tool. Claude can run the checks and draft the post. The runs cost a few dollars of Apify usage.
- **Answer reviews and issues quickly.** Store ranking rewards Actors whose runs succeed and whose authors respond.

## Keeping it running

- **Code changes:** Claude works on the `claude/amazing-babbage-ktqwpx` branch. Merge it into `main`, then select **Build** on the changed Actors. To rebuild automatically on every push, see [Apify: Git repository sources](https://docs.apify.com/platform/actors/development/deployment/source-types#git-repository).
- **Health:** if Apify emails that an Actor is failing its daily test, forward the email to Claude. At that point the Store labels the Actor "under maintenance", and after about four more weeks of failures Apify deprecates it.
- **Open source:** the repository is public under the MIT license, so anyone can copy the code. Your advantage is the Store listing, its reviews and keeping the checks current. To keep new code private, move `ai-readiness/` to a private repository and add a deploy key for each Actor.

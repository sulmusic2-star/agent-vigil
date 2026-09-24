# Go live on Apify Store

The six Actors are built, tested and documented, with Store pages, icons and prices ready. What's left needs you, because it involves your identity, your money or publishing under your name. Plan on about 30 minutes.

## Your checklist

1. **Create a free Apify account** at <https://console.apify.com/sign-up>. Your username appears in every Store link (`apify.com/<username>/ai-agent-readiness-audit`), so pick a short, brand-like name.
2. **Let Claude set up the six Actors.**
   1. In Apify Console, open **Settings** > **API & Integrations** and copy your API token. It has to be a full-access token, because Apify doesn't let limited tokens create Actors. You can delete it once setup is done.
   2. In this Claude environment's settings (the cloud environment menu in the session's title bar, then **Edit**), add `api.apify.com` to the allowed network domains, and add an environment variable named `APIFY_TOKEN` that holds the token. Don't paste the token into a chat.
   3. For the AI Product Recommendation Tracker, add its AI keys as environment variables in the same place. The setup script copies them into the Actor as secrets, and the Actor pays for AI answers with them:
      - `OPENAI_API_KEY` from <https://platform.openai.com/api-keys> (add about $10 of credit)
      - `PERPLEXITY_API_KEY` from <https://www.perplexity.ai/account/api> (add about $10 of credit)
      - `GEMINI_API_KEY` from <https://aistudio.google.com/apikey> (has a free daily allowance)
      - optional: `ANTHROPIC_API_KEY` from <https://console.anthropic.com/settings/keys>, to offer Claude answers too

      An assistant without a key is skipped, so you can start with one or two.
   4. Start a new Claude session on this repository and send: *Check out the branch `claude/amazing-babbage-ktqwpx`, then set up the ai-readiness Actors on Apify by running `python3 ai-readiness/scripts/deploy_apify.py --branch claude/amazing-babbage-ktqwpx`, and fix anything that fails.*

   Claude then creates the six Actors in your account, builds each one and runs it once with its example input. To do this step yourself instead, see [Set up the Actors by hand](#set-up-the-actors-by-hand).
3. **Set up payouts (once).** In any Actor's **Publishing** tab, under **Monetization**, enter your billing details and a payout method. PayPal or Wise pays out from $20; other methods from $100. Then verify your identity under **Development** > **Insights** > **Payouts**. Apify pays monthly: invoices are created on the 11th for the previous month.
4. **Price each Actor.** In **Publishing** > **Monetization**, select **Set up monetization**, choose pay per event, and then:
   - Keep `apify-actor-start` at Apify's default price.
   - Set `apify-default-dataset-item` to the price in the table, with the event title from the table. It charges once per result. Sites that don't respond and invalid inputs aren't saved, so they aren't charged.
   - Choose `apify-default-dataset-item` as the primary event, then confirm.
   - For the AI Product Recommendation Tracker, also add one event per AI answer, with these names, titles and prices: `chatgpt-answer` (ChatGPT answer) $0.05, `perplexity-answer` (Perplexity answer) $0.03, `gemini-answer` (Gemini answer) $0.05 and `claude-answer` (Claude answer) $0.35. The event names must match exactly, because the Actor charges them by name.
5. **Publish each Actor.** In **Publishing**:
   - **Display information:** upload the icon from `ai-readiness/store-assets/icons/` (PNG). Check the categories and SEO text, which the setup script fills in from [Store listing text](#store-listing-text); if Apify rejected a suggested category, pick the closest one it offers.
   - **Sample output:** use the test run from step 2.
   - **Actor permissions:** keep **Limited permissions**. The Actors need nothing more.
   - Select **Publish on Store**.

After that the Actors run without you. Apify tests each one daily with its prefilled input and emails you if one fails three days in a row. Forward that email to Claude.

## Set up the Actors by hand

Instead of step 2, for each row in [the Actor table](#the-six-actors):

1. Go to **Development** > **My Actors** and create a new Actor.
2. On its **Source** tab, set **Source type** to **Git repository** and paste the Git URL from the table. The repository is public, so no deploy key is needed.
3. Select **Build**. The build takes about a minute.
4. Select **Start** with the prefilled input. When the run finishes, the **Output** tab should show results. If it shows none, stop here and tell Claude.
5. In **Publishing** > **Display information**, paste the SEO title and description and pick the categories from [Store listing text](#store-listing-text).

## The six Actors

Git URL prefix for every Actor: `https://github.com/sulmusic2-star/agent-vigil#claude/amazing-babbage-ktqwpx:ai-readiness/actors/`

The Actors build from the `claude/amazing-babbage-ktqwpx` branch because the pull request into `main` ([#246](https://github.com/sulmusic2-star/agent-vigil/pull/246)) is blocked by the repository's Agent Vigil gate. If you merge it from the GitHub website, change `#claude/amazing-babbage-ktqwpx:` to `#main:`, or rerun the setup script with `--branch main`.

| Actor | Git URL ends with | Price per result | Per 1,000 | Event title |
|---|---|---|---|---|
| AI Agent Readiness Audit | `ai-agent-readiness-audit` | $0.02 | $20 | Website audited |
| llms.txt Generator | `llms-txt-generator` | $0.05 | $50 | llms.txt generated |
| AI Crawler Access Checker | `ai-crawler-access-checker` | $0.004 | $4 | Website checked |
| llms.txt Validator | `llms-txt-validator` | $0.003 | $3 | Website checked |
| Product Schema Checker for AI Shopping | `product-schema-checker` | $0.003 | $3 | Product page checked |
| AI Product Recommendation Tracker | `ai-product-recommendation-tracker` | $0.01 | $10 | Question tracked |

The AI Product Recommendation Tracker also charges per AI answer (step 4). A question with the default settings uses 6 answers, 2 each from ChatGPT, Perplexity and Gemini, so a user pays about $0.27 per question.

**Why these prices.** Apify's platform costs for one result are well under a cent: a few seconds of a 512 MB container at $0.20 per GB-hour, plus 1–10 MB of traffic at $0.20 per GB. You keep 80% of what users pay, minus those costs. The two cheap checkers are for people who check thousands of sites. The audit and the generator give one finished report or file per site, so they cost more.

For the tracker, each new AI answer costs about 1–3 cents in API fees (a Claude answer with web search costs more, about 15–30 cents). At the prices above you keep about half of a new answer's price. An answer reused later the same week costs nothing, so you keep all 80% of its price.

**Changing prices later.** Lowering a price takes effect at once. Raising one takes effect after 14 days if the Actor has paying users, and you can make one such change per Actor per month.

## Store listing text

| Actor | Suggested categories | SEO title | SEO description |
|---|---|---|---|
| AI Agent Readiness Audit | SEO tools, AI | AI Readiness Audit: Score Any Website for AI Agents | Score websites 0–100 for AI search and agents: firewall blocks on AI crawlers, JavaScript-only pages, structured data, WebMCP, llms.txt. Ranked fixes. |
| llms.txt Generator | SEO tools, Developer tools | llms.txt Generator: Create llms.txt for Any Website | Generate a valid, ready-to-publish llms.txt for any website from its homepage links, sitemap and page titles. Bulk runs, downloadable files. |
| AI Crawler Access Checker | SEO tools, AI | AI Crawler Checker: robots.txt vs Firewall Blocks | See which AI crawlers each site allows in robots.txt and which its firewall or CDN actually blocks: GPTBot, ClaudeBot, PerplexityBot and more. |
| llms.txt Validator | SEO tools, Developer tools | llms.txt Validator: Check llms.txt Files in Bulk | Check whether websites publish a valid llms.txt per llmstxt.org: structure, links, summary, size and llms-full.txt. One site or thousands. |
| Product Schema Checker for AI Shopping | E-commerce, SEO tools | Product Schema Checker for AI Shopping Agents | Score product pages on the schema.org Product data AI shopping assistants use: price, availability, GTIN, brand, reviews, shipping and returns. |
| AI Product Recommendation Tracker | AI, E-commerce | AI Product Recommendations: ChatGPT, Perplexity, Gemini | See which products ChatGPT, Perplexity, Gemini and Claude recommend for any shopping question, your brand's share and position, and the sites they cite. |

The title, short description and full Store page of each Actor come from its `.actor/actor.json` and `.actor/README.md`, so they are already filled in.

## What to expect

Store income builds slowly. Most new Actors earn little in their first months, and income grows with good reviews, successful runs and time in the Store's search results. These are a bet on a growing need, not a guaranteed income.

Two things help most once the Actors are live:

- **Use the Actors to make public data.** For example: check the 1,000 most popular websites for AI crawler rules and llms.txt, and post the findings with a link to the Actors. Posts like this bring people who need the tool. Claude can run the checks and draft the post. The runs cost a few dollars of Apify usage.
- **Answer reviews and issues quickly.** Store ranking rewards Actors whose runs succeed and whose authors respond.

## Keeping it running

- **Code changes:** Claude makes each change on a branch and opens a pull request. The repository's Agent Vigil gate is built for changes to Agent Vigil itself: it limits a pull request to 20 files, and requires a linked issue and a change under `test-hosted/`. Pull requests for these tools don't meet those rules, so merging them into `main` needs your admin override. After a merge, rerun the setup script or select **Build** on the changed Actors. To rebuild automatically on every push, see [Apify: Git repository sources](https://docs.apify.com/platform/actors/development/deployment/source-types#git-repository).
- **Health:** if Apify emails that an Actor is failing its daily test, forward the email to Claude. At that point the Store labels the Actor "under maintenance", and after about four more weeks of failures Apify deprecates it.
- **Open source:** the repository is public under the MIT license, so anyone can copy the code. Your advantage is the Store listing, its reviews and keeping the checks current. To keep new code private, move `ai-readiness/` to a private repository and add a deploy key for each Actor.

# AI Readiness Actors

Five [Apify](https://apify.com) Actors that check how websites look to AI crawlers, AI assistants and AI agents. They share one engine (`readiness/`) and one runtime (`actorkit/`), and they are sold on Apify Store with pay-per-result pricing.

| Actor | What one result is | Folder |
|---|---|---|
| AI Agent Readiness Audit | A 0–100 score, grade and ranked fixes for one website | `actors/ai-agent-readiness-audit` |
| AI Crawler Access Checker | Which AI crawlers one website allows or blocks, and why | `actors/ai-crawler-access-checker` |
| llms.txt Validator | Whether one website's `/llms.txt` exists and follows llmstxt.org | `actors/llms-txt-validator` |
| llms.txt Generator | A ready-to-publish llms.txt for one website | `actors/llms-txt-generator` |
| Product Schema Checker for AI Shopping | Product JSON-LD completeness for one product page | `actors/product-schema-checker` |

Each Actor's `.actor/README.md` is its Store page. [GO_LIVE.md](GO_LIVE.md) lists the steps to publish and price them.

## Layout

```
readiness/   engine: fetching, robots.txt (RFC 9309), llms.txt, sitemaps, JSON-LD,
             WebMCP, discovery files, scoring; no Apify dependency
actorkit/    Apify runtime: input parsing, concurrency, fair billing, change monitoring
actors/*/    one folder per Actor: .actor/ (actor.json, schemas, README) and main.py
shared/      the Dockerfile and requirements.txt every Actor builds from
tests/       unit tests, plus end-to-end runs of every Actor against a local test site
store-assets/  Store icons: SVG sources and 512×512 PNGs
```

## How the Actors behave

- **Fair billing.** Each Actor charges through Apify's built-in `apify-default-dataset-item` event, one charge per dataset item. Sites that don't respond, invalid entries, pages that return an error and timeouts are not saved, so they are not charged. They are listed in the run's `OUTPUT` record instead. A run stops starting new sites when the user's spending limit is reached.
- **Polite.** Files published for automated readers (robots.txt, llms.txt, sitemaps, `/.well-known`) are read directly. HTML pages and scripts are fetched only when robots.txt allows the `AIReadinessAudit` token. Every request has a time and size limit.
- **Redirects.** When a homepage redirects (for example `example.com` to `www.example.com`), the audit and the generator check the site it lands on and report it as `finalUrl`.
- **Monitoring.** With **Report changes since the last run** on, results are compared with the previous run's snapshot, kept in a named key-value store, and each result lists what changed.

## Develop

Python 3.11 or later.

```bash
cd ai-readiness
python -m venv .venv && . .venv/bin/activate
pip install -r shared/requirements.txt pytest
python -m pytest -q
```

The end-to-end tests run each Actor's `main.py` in a subprocess with the Apify SDK in local mode, against a test site served on 127.0.0.1. They are skipped if `apify` or `httpx` is not installed.

Run one Actor locally:

```bash
mkdir -p storage/key_value_stores/default
echo '{"websites": ["example.com"]}' > storage/key_value_stores/default/INPUT.json
PYTHONPATH=. python actors/ai-agent-readiness-audit/main.py
ls storage/datasets/default/
```

Build an Actor image the way Apify does (the Docker context is this folder):

```bash
docker build -f shared/Dockerfile \
  --build-arg ACTOR_PATH_IN_DOCKER_CONTEXT=actors/ai-agent-readiness-audit \
  -t ai-agent-readiness-audit .
```

## Deploy on Apify

Each Actor is built from this repository, with the Actor's folder as the Git source. For example:

```
https://github.com/sulmusic2-star/agent-vigil#main:ai-readiness/actors/ai-agent-readiness-audit
```

`actor.json` sets `dockerContextDir` to this folder and `dockerfile` to `shared/Dockerfile`. Apify passes the Actor's folder to the build as `ACTOR_PATH_IN_DOCKER_CONTEXT`, so all five Actors share one Dockerfile. See [Apify: Actor monorepos](https://docs.apify.com/platform/actors/development/deployment/source-types#actor-monorepos).

## Keep the lists current

- AI crawler tokens: `readiness/agents.py`. Check vendors' crawler documentation every few months.
- Score weights and fix wording: `readiness/score.py`.
- WebMCP is a W3C draft. If the attribute names or `document.modelContext` API change, update `readiness/webmcp.py`.

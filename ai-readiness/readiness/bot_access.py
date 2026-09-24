"""Can AI crawlers actually read a site? Checks that robots.txt alone can't answer.

* Content without JavaScript: most AI crawlers read the HTML as served and don't
  run scripts. A page whose HTML carries almost no text looks nearly empty to them.
* Firewall and CDN blocks: the homepage is fetched with a normal browser user agent
  and with the user agents of AI crawlers that robots.txt allows. When only the
  crawler requests are blocked or challenged, a firewall rule or bot-protection
  setting is turning those crawlers away even though robots.txt lets them in.
* Markdown for agents: whether the site offers a Markdown version of the page,
  through ``Accept: text/markdown`` or a ``<link rel="alternate" type="text/markdown">``.

Crawlers that robots.txt already disallows are not imitated. Each crawler request
also names this tool in its user agent. Sites that verify real crawlers by IP
address may refuse any imitation, so a block seen here is a strong hint, not proof.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from .fetch import USER_AGENT, Fetcher, Response
from .html_scan import PageScan, scan_html
from .robots import RobotsTxt

BROWSER_USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")


@dataclass(frozen=True)
class TestAgent:
    token: str
    purpose: str  # search | user | training
    user_agent: str


def _ua(product: str, info: str) -> str:
    # The crawler's own product token triggers the same firewall rules the real
    # crawler meets; the suffix tells the site owner who actually sent it.
    return (f"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; {product}; +{info}) "
            f"{USER_AGENT.split(' ', 1)[0]} (access test)")


# The crawlers behind AI answers (search indexers and on-request fetchers), plus
# the two largest training crawlers, whose blocking publishers often want to verify.
TEST_AGENTS: tuple[TestAgent, ...] = (
    TestAgent("OAI-SearchBot", "search", _ua("OAI-SearchBot/1.0", "https://openai.com/searchbot")),
    TestAgent("ChatGPT-User", "user", _ua("ChatGPT-User/1.0", "https://openai.com/bot")),
    TestAgent("Claude-User", "user", _ua("Claude-User/1.0", "Claude-User@anthropic.com")),
    TestAgent("PerplexityBot", "search", _ua("PerplexityBot/1.0", "https://perplexity.ai/perplexitybot")),
    TestAgent("GPTBot", "training", _ua("GPTBot/1.1", "https://openai.com/gptbot")),
    TestAgent("ClaudeBot", "training", _ua("ClaudeBot/1.0", "claudebot@anthropic.com")),
)

BLOCK_STATUSES = {401, 403, 406, 429, 451, 503}
# Phrases from bot-protection interstitials (Cloudflare, Imperva, DataDome, PerimeterX, Akamai, Sucuri).
CHALLENGE_MARKERS = (
    "just a moment...", "attention required! | cloudflare", "/cdn-cgi/challenge-platform/", "cf_chl_opt",
    "_incapsula_resource", "captcha-delivery.com", "px-captcha", "checking your browser",
    "please enable cookies", "access denied", "request unsuccessful", "sucuri website firewall",
)
MAX_PAGE_BYTES = 1_500_000
THIN_TEXT_CHARS = 600
EMPTY_TEXT_CHARS = 150


def edge_provider(headers: dict[str, str]) -> str | None:
    """Best guess at the CDN or firewall in front of the site, from response headers."""

    server = headers.get("server", "").lower()
    if "cf-ray" in headers or server == "cloudflare":
        return "Cloudflare"
    if "akamai" in server or any(h.startswith("x-akamai") for h in headers):
        return "Akamai"
    if "x-iinfo" in headers or "incap_ses" in headers.get("set-cookie", "").lower():
        return "Imperva"
    if "x-datadome" in headers or "datadome" in headers.get("set-cookie", "").lower():
        return "DataDome"
    if "x-sucuri-id" in headers or "sucuri" in server:
        return "Sucuri"
    if "x-vercel-id" in headers or server == "vercel":
        return "Vercel"
    if "x-amz-cf-id" in headers or server == "cloudfront":
        return "Amazon CloudFront"
    if "fastly" in server or "cache-" in headers.get("x-served-by", ""):
        return "Fastly"
    return None


def classify(resp: Response) -> tuple[str, str | None]:
    """ok | blocked | challenged | error, with a short reason."""

    if resp.status is None:
        return "error", resp.error or "no response"
    if resp.headers.get("cf-mitigated", "").lower() == "challenge":
        return "challenged", "bot challenge page"
    small = len(resp.body) < 40_000
    head = resp.body[:8_000].decode("utf-8", "replace").lower() if (small or not resp.ok) else ""
    marker = next((m for m in CHALLENGE_MARKERS if m in head), None)
    if marker:
        return ("challenged" if resp.ok else "blocked"), f"bot protection page ({marker.strip('.')})"
    if resp.status in BLOCK_STATUSES:
        return "blocked", f"HTTP {resp.status}"
    if not resp.ok:
        return "error", f"HTTP {resp.status}"
    return "ok", None


def content_without_js(scan: PageScan) -> dict[str, Any]:
    """How much of the homepage a crawler that doesn't run JavaScript can read."""

    chars = scan.text_chars
    if chars < EMPTY_TEXT_CHARS and (scan.script_count or scan.noscript_js_notice):
        status = "empty"
        note = ("the page is built by JavaScript: crawlers that don't run scripts, as most AI crawlers "
                f"don't, see about {chars} characters of text")
    elif chars < THIN_TEXT_CHARS and scan.script_count:
        status = "thin"
        note = f"only about {chars} characters of text are in the HTML; the rest likely needs JavaScript"
    else:
        status = "ok"
        note = None
    return {"status": status, "textChars": chars, "scripts": scan.script_count,
            "noscriptNotice": scan.noscript_js_notice, "note": note}


async def _fetch(fetcher: Fetcher, url: str, user_agent: str, accept: str | None = None) -> Response:
    headers = {"User-Agent": user_agent}
    if accept:
        headers["Accept"] = accept
    return await fetcher.get(url, max_bytes=MAX_PAGE_BYTES, headers=headers)


def _text_chars(resp: Response) -> int:
    return scan_html(resp.text).text_chars if resp.ok and resp.looks_like_html() else 0


async def crawler_reach(fetcher: Fetcher, page_url: str, robots: RobotsTxt,
                        scan: PageScan | None = None) -> dict[str, Any]:
    """Run the reach checks for one page (normally the homepage)."""

    parts = urlsplit(page_url)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    allowed = [a for a in TEST_AGENTS if robots.check(a.token, path).allowed]
    skipped = [a for a in TEST_AGENTS if a not in allowed]

    baseline, markdown_resp, *agent_resps = await asyncio.gather(
        _fetch(fetcher, page_url, BROWSER_USER_AGENT),
        _fetch(fetcher, page_url, BROWSER_USER_AGENT, accept="text/markdown"),
        *(_fetch(fetcher, page_url, a.user_agent) for a in allowed),
    )
    base_result, base_reason = classify(baseline)
    base_chars = _text_chars(baseline)
    edge = edge_provider(baseline.headers) or next(
        (p for p in (edge_provider(r.headers) for r in agent_resps) if p), None)

    rows = []
    for agent, resp in zip(allowed, agent_resps):
        result, reason = classify(resp)
        chars = _text_chars(resp)
        if result == "ok" and base_result == "ok" and base_chars > 800 and chars < base_chars * 0.5:
            result, reason = "reduced", f"gets {chars} characters of text; a browser gets {base_chars}"
        rows.append({"agent": agent.token, "purpose": agent.purpose, "result": result,
                     "httpStatus": resp.status, "note": reason})
    for agent in skipped:
        rows.append({"agent": agent.token, "purpose": agent.purpose, "result": "not-tested",
                     "httpStatus": None, "note": "robots.txt already asks this crawler to stay out"})

    inconclusive = base_result != "ok"
    turned_away = [r["agent"] for r in rows if r["result"] in {"blocked", "challenged"}]
    answering_blocked = [r["agent"] for r in rows
                         if r["result"] in {"blocked", "challenged"} and r["purpose"] in {"search", "user"}]
    markdown_ok = bool(markdown_resp.ok and markdown_resp.content_type in {"text/markdown", "text/x-markdown"})

    if inconclusive:
        summary = (f"The site turned away a normal browser request too ({base_reason}), "
                   "so crawler access could not be compared")
    elif turned_away:
        where = f"{edge} or the site's firewall" if edge else "the site's firewall or CDN"
        summary = f"{where} turns away {', '.join(turned_away)}, although robots.txt allows them"
    else:
        summary = "Every AI crawler that robots.txt allows got the page"

    js = content_without_js(scan) if scan is not None else None
    return {
        "summary": summary,
        "contentWithoutJavaScript": js,
        "firewall": {
            "edgeProvider": edge,
            "browser": {"result": base_result, "httpStatus": baseline.status, "textChars": base_chars,
                        "note": base_reason},
            "agents": rows,
            "turnedAway": turned_away,
            "answeringCrawlersTurnedAway": answering_blocked,
            "inconclusive": inconclusive,
        },
        "markdown": {
            "acceptHeader": markdown_ok,
            "alternateLink": bool(scan.markdown_alternates) if scan is not None else False,
        },
        "caveat": ("Crawler requests were sent from this tool's servers with each crawler's user agent. "
                   "Sites that verify real crawlers by IP address may treat the real crawlers differently."),
    }


def firewall_fix(reach: dict[str, Any]) -> str | None:
    """A concrete next step when answering crawlers are turned away."""

    blocked = reach["firewall"]["answeringCrawlersTurnedAway"]
    if not blocked or reach["firewall"]["inconclusive"]:
        return None
    names = ", ".join(blocked)
    if reach["firewall"]["edgeProvider"] == "Cloudflare":
        return (f"Let {names} through: in Cloudflare, check AI Crawl Control and bot settings "
                "(such as blocking AI bots or Bot Fight Mode) and allow the AI crawlers you want")
    where = reach["firewall"]["edgeProvider"] or "your firewall or CDN"
    return f"Let {names} through: check the bot-protection rules in {where} and allow the AI crawlers you want"

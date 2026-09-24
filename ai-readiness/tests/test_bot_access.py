"""Crawler reach: firewall blocks per AI crawler, JavaScript-only pages, Markdown versions."""

import asyncio

from readiness import audit, bot_access
from readiness.fetch import FakeFetcher
from readiness.html_scan import scan_html
from readiness.robots import parse

O = "https://shop.example/"
ARTICLE = "<p>" + "Trail running shoes, sizing advice and care guides. " * 30 + "</p>"
HOME = f"<html><head><title>Shop</title></head><body><h1>Shop</h1>{ARTICLE}</body></html>"
CF = {"server": "cloudflare", "cf-ray": "8a1b2c3d4e5f-AMS"}
CHALLENGE = ("<html><head><title>Just a moment...</title></head><body>"
             "<script src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'></script></body></html>")
OPEN_ROBOTS = parse("User-agent: *\nAllow: /\n")


def reach(fetcher, robots=OPEN_ROBOTS, html=HOME):
    return asyncio.run(bot_access.crawler_reach(fetcher, O, robots, scan_html(html)))


def rows(result):
    return {r["agent"]: r for r in result["firewall"]["agents"]}


def test_firewall_that_turns_away_some_ai_crawlers_is_reported():
    fetcher = FakeFetcher(
        {O: (200, "text/html", HOME, CF)},
        variants={("user-agent", "ClaudeBot"): {O: (403, "text/html", "<h1>Forbidden</h1>", CF)},
                  ("user-agent", "PerplexityBot"): {O: (200, "text/html", CHALLENGE, {**CF, "cf-mitigated": "challenge"})}},
    )
    r = reach(fetcher)
    by_agent = rows(r)
    assert by_agent["ClaudeBot"]["result"] == "blocked" and by_agent["ClaudeBot"]["httpStatus"] == 403
    assert by_agent["PerplexityBot"]["result"] == "challenged"
    assert by_agent["OAI-SearchBot"]["result"] == "ok" and by_agent["GPTBot"]["result"] == "ok"
    assert r["firewall"]["edgeProvider"] == "Cloudflare" and not r["firewall"]["inconclusive"]
    assert r["firewall"]["answeringCrawlersTurnedAway"] == ["PerplexityBot"]  # ClaudeBot trains; it isn't an answer bot
    assert "turns away PerplexityBot, ClaudeBot, although robots.txt allows them" in r["summary"]
    assert "in Cloudflare, check AI Crawl Control" in bot_access.firewall_fix(r)


def test_challenge_page_is_recognised_without_special_headers():
    fetcher = FakeFetcher({O: (200, "text/html", HOME)},
                          variants={("user-agent", "OAI-SearchBot"): {O: (503, "text/html", CHALLENGE)}})
    assert rows(reach(fetcher))["OAI-SearchBot"]["result"] == "blocked"


def test_crawlers_that_robots_txt_disallows_are_never_imitated():
    fetcher = FakeFetcher({O: (200, "text/html", HOME)})
    r = reach(fetcher, robots=parse("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"))
    assert rows(r)["GPTBot"]["result"] == "not-tested"
    assert not any("GPTBot" in h.get("user-agent", "") for h in fetcher.requested_headers)
    assert all("AIReadinessAudit" in h["user-agent"] for h in fetcher.requested_headers
               if "compatible" in h.get("user-agent", ""))  # crawler requests also name this tool


def test_blocked_browser_makes_the_comparison_inconclusive():
    fetcher = FakeFetcher({O: (403, "text/html", "<h1>Access denied</h1>")})
    r = reach(fetcher)
    assert r["firewall"]["inconclusive"] and bot_access.firewall_fix(r) is None
    assert "could not be compared" in r["summary"]


def test_crawler_served_a_much_shorter_page_is_flagged():
    fetcher = FakeFetcher({O: (200, "text/html", HOME)},
                          variants={("user-agent", "ChatGPT-User"): {O: (200, "text/html", "<p>Hello</p>")}})
    row = rows(reach(fetcher))["ChatGPT-User"]
    assert row["result"] == "reduced" and "a browser gets" in row["note"]


def test_javascript_only_page_and_markdown_version():
    spa = ('<html><head><script src="/app.js"></script></head><body><noscript>Please enable JavaScript.</noscript>'
           '<div id="root"></div></body></html>')
    fetcher = FakeFetcher({O: (200, "text/html", spa)},
                          variants={("accept", "text/markdown"): {O: (200, "text/markdown", "# Shop\n")}})
    r = reach(fetcher, html=spa)
    assert r["contentWithoutJavaScript"]["status"] == "empty" and r["contentWithoutJavaScript"]["noscriptNotice"]
    assert r["markdown"]["acceptHeader"] and not r["markdown"]["alternateLink"]
    thin = bot_access.content_without_js(scan_html(f'<body><p>{"Short intro text. " * 15}</p><script>app()</script></body>'))
    assert thin["status"] == "thin"


def test_audits_report_reach_and_licenses():
    robots = "User-agent: *\nAllow: /\nLicense: https://shop.example/license.xml\n"
    fetcher = FakeFetcher(
        {O + "robots.txt": (200, "text/plain", robots), O: (200, "text/html", HOME, CF)},
        variants={("user-agent", "OAI-SearchBot"): {O: (403, "text/html", "denied", CF)}},
    )
    checker = asyncio.run(audit.audit_crawler_access(fetcher, "shop.example"))
    assert checker["rslLicenses"] == ["https://shop.example/license.xml"]
    assert checker["actualAccess"]["turnedAway"] == ["OAI-SearchBot"] and checker["actualAccess"]["fix"]
    full = asyncio.run(audit.audit_readiness(fetcher, "shop.example"))
    assert full["crawlerReach"]["firewall"]["answeringCrawlersTurnedAway"] == ["OAI-SearchBot"]
    assert full["areas"]["Crawler reach"]["earned"] < full["areas"]["Crawler reach"]["possible"]
    assert "firewall turns away OAI-SearchBot" in full["summary"]
    quiet = asyncio.run(audit.audit_readiness(fetcher, "shop.example", test_reach=False))
    assert quiet["crawlerReach"] is None and "Crawler reach" not in quiet["areas"]

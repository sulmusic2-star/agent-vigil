"""Entry points on a fake site, plus the runner's billing-fairness rules."""

import asyncio

from actorkit import monitor
from actorkit.runner import collect_inputs, process
from readiness import audit
from readiness.fetch import FakeFetcher

O = "https://shop.example/"
ROBOTS = """User-agent: GPTBot
Disallow: /

User-agent: *
Content-Signal: search=yes, ai-train=no
Allow: /
Sitemap: https://shop.example/sitemap.xml
"""
HOME = """<!doctype html><html lang="en"><head><title>Shop Example | Shoes</title>
<meta name="description" content="Running shoes."><link rel="canonical" href="https://shop.example/">
<script type="application/ld+json">{"@type":"Organization","name":"Shop Example"}</script></head>
<body><form toolname="search" tooldescription="Search the catalog for shoes by keyword">
<input name="q" toolparamdescription="Keywords"></form><a href="/about">About</a></body></html>"""
PRODUCT = """<html><head><script type="application/ld+json">{"@type":"Product","name":"Runner",
"offers":{"price":"99","priceCurrency":"USD","availability":"InStock"}}</script></head></html>"""


def site(**extra):
    pages = {
        O + "robots.txt": (200, "text/plain", ROBOTS),
        O: (200, "text/html", HOME),
        O + "llms.txt": (200, "text/plain", "# Shop Example\n\n> Shoes.\n\n## Pages\n\n- [About](https://shop.example/about)\n"),
        O + "sitemap.xml": (200, "application/xml",
                            '<urlset><url><loc>https://shop.example/about</loc></url></urlset>'),
        O + "about": (200, "text/html", "<html><head><title>About</title></head></html>"),
        O + "p/runner": (200, "text/html", PRODUCT),
    }
    pages.update(extra)
    return FakeFetcher(pages)


def test_crawler_access_result():
    r = asyncio.run(audit.audit_crawler_access(site(), "shop.example"))
    assert r["reachable"] and r["url"] == O
    gpt = next(a for a in r["agents"] if a["agent"] == "GPTBot")
    assert gpt["status"] == "blocked" and gpt["matchedGroup"] == "GPTBot"
    assert r["contentSignals"] == {"search": "yes", "ai-train": "no"}
    assert "declares ai-train=no" in r["policySummary"]
    assert r["pageDirectives"]["noAiDirectives"] == []


def test_readiness_result_and_fixes():
    r = asyncio.run(audit.audit_readiness(site(), "https://shop.example"))
    assert r["reachable"] and not r["partialScore"] and 0 < r["score"] <= 100
    assert r["webmcp"]["declarativeTools"][0]["name"] == "search"
    assert r["structuredData"]["types"] == ["Organization"]
    assert r["llmsTxt"]["valid"] and r["sitemapFound"]
    assert r["fixes"] and all("action" in f for f in r["fixes"])


def test_readiness_is_partial_when_robots_disallows_this_tool():
    blocked = site(**{O + "robots.txt": (200, "text/plain", "User-agent: AIReadinessAudit\nDisallow: /\n")})
    r = asyncio.run(audit.audit_readiness(blocked, O))
    assert r["partialScore"] and r["structuredData"] is None and r["webmcp"] is None
    assert any("robots.txt disallows" in n for n in r["notes"])
    assert O not in blocked.requested  # homepage was never fetched


def test_unreachable_site_is_flagged():
    dead = FakeFetcher({O + "robots.txt": (0, "", ""), O: (0, "", ""), O + "llms.txt": (0, "", ""),
                        O + "llms-full.txt": (0, "", ""), O + ".well-known/tdmrep.json": (0, "", "")})
    assert asyncio.run(audit.audit_crawler_access(dead, O))["reachable"] is False
    assert asyncio.run(audit.audit_llms_txt(dead, O))["reachable"] is False


def test_invalid_input():
    assert "error" in asyncio.run(audit.audit_llms_txt(site(), "ftp://nope"))


def test_generator_and_product():
    g = asyncio.run(audit.generate_llms_txt(site(), O, max_pages=5))
    assert g["draftValid"] and g["llmsTxt"].startswith("# Shop Example\n") and g["existingLlmsTxt"]
    p = asyncio.run(audit.audit_product_page(site(), O + "p/runner"))
    assert p["productName"] == "Runner" and "brand" in p["missing"] and p["score"] > 0
    missing = asyncio.run(audit.audit_product_page(site(), O + "p/gone"))
    assert missing["error"] == "HTTP 404"


def test_collect_inputs_normalizes_dedupes_and_flags_invalid():
    targets, invalid = collect_inputs("readiness", {
        "websites": ["Example.com", "https://example.com/page", "ftp://x", ""],
        "startUrls": [{"url": "https://other.com"}],
    })
    assert targets == ["https://example.com/", "https://other.com/"]
    assert invalid == [{"input": "ftp://x", "reason": "not a valid http(s) URL or domain"}]
    product_targets, _ = collect_inputs("product", {"productUrls": ["shop.com/p/1?color=red"]})
    assert product_targets == ["https://shop.com/p/1?color=red"]


def _run(targets, results, limit_after=None, timeout=5):
    pushed = []

    async def audit_fn(t):
        value = results[t]
        if isinstance(value, Exception):
            raise value
        if value == "slow":
            await asyncio.sleep(10)
        return value

    async def push_fn(item):
        pushed.append(item["url"])
        return limit_after is not None and len(pushed) >= limit_after

    summary = asyncio.run(process(targets, audit_fn, push_fn, concurrency=1, timeout=timeout))
    return summary, pushed


def test_only_useful_results_are_saved_and_charged():
    results = {
        "a": {"url": "a", "reachable": True},
        "b": {"url": "b", "reachable": False},
        "c": {"url": "c", "error": "HTTP 404"},
        "d": {"url": "d", "skipped": "robots.txt disallows"},
        "e": RuntimeError("boom"),
    }
    summary, pushed = _run(list(results), results)
    assert pushed == ["a"] and summary.saved == 1
    reasons = {f["input"]: f["reason"] for f in summary.failed}
    assert set(reasons) == {"b", "c", "d", "e"} and "boom" in reasons["e"]


def test_timeouts_are_not_charged():
    summary, pushed = _run(["s"], {"s": "slow"}, timeout=0.05)
    assert pushed == [] and "timed out" in summary.failed[0]["reason"]


def test_spending_limit_stops_new_work():
    targets = ["a", "b", "c", "d"]
    results = {t: {"url": t, "reachable": True} for t in targets}
    summary, pushed = _run(targets, results, limit_after=2)
    assert pushed == ["a", "b"] and summary.stopped_by_spending_limit and summary.not_started == 2


def test_monitor_reports_changes():
    before = monitor.snapshot("crawler-access", {"policy": "open", "agents": [{"agent": "GPTBot", "status": "allowed"}]})
    after = monitor.snapshot("crawler-access", {"policy": "mixed", "agents": [{"agent": "GPTBot", "status": "blocked"}]})
    changes = monitor.diff(before, after)
    assert {"field": "agents.GPTBot", "before": "allowed", "after": "blocked"} in changes
    assert {"field": "policy", "before": "open", "after": "mixed"} in changes
    assert monitor.diff(None, after) == []
    assert monitor.store_key("https://www.shop.example/") == "www.shop.example"


W = "https://www.shop.example/"
WWW_HOME = """<html><head><title>Shop Example</title><meta name="description" content="Running shoes."></head><body>
<a href="/login?next=/">Sign in</a> <a href="/cart">Cart</a> <a href="/pricing">Pricing</a>
<a href="/blog/a">A</a> <a href="https://www.shop.example/blog/b">B</a> <a href="https://other.example/x">X</a>
</body></html>"""


def www_site():
    """shop.example redirects everything to www.shop.example, like most real sites."""

    page = lambda title: (200, "text/html", f"<html><head><title>{title} | Shop Example</title></head></html>")
    pages = {
        W + "robots.txt": (200, "text/plain", "User-agent: *\nAllow: /\nSitemap: https://www.shop.example/sitemap.xml\n"),
        W: (200, "text/html", WWW_HOME),
        W + "sitemap.xml": (200, "application/xml", "<urlset><url><loc>https://www.shop.example/about</loc></url>"
                                                    "<url><loc>https://www.shop.example/blog/c</loc></url></urlset>"),
        W + "llms.txt": (200, "text/plain", "# Shop\n\n> Shoes.\n\n## Pages\n\n- [About](https://www.shop.example/about)\n"),
        W + "pricing": page("Pricing"), W + "about": page("About us"),
        W + "blog/a": page("Post A"), W + "blog/b": page("Post B"), W + "blog/c": page("Post C"),
        W + "cart": page("Cart"), W + "login": page("Sign in"),
    }
    redirects = {O + path: W + path for path in ["", "robots.txt", "llms.txt", "llms-full.txt", "sitemap.xml"]}
    return FakeFetcher(pages, redirects)


def test_generator_follows_redirect_to_www_and_skips_utility_pages():
    g = asyncio.run(audit.generate_llms_txt(www_site(), "shop.example"))
    text = g["llmsTxt"]
    assert g["url"] == O and g["finalUrl"] == W and g["existingLlmsTxt"]
    assert any("redirects to https://www.shop.example/" in n for n in g["notes"])
    for path in ["pricing", "about", "blog/a", "blog/b", "blog/c"]:
        assert f"({W}{path})" in text, path  # homepage links and sitemap URLs, on the final site
    assert "login" not in text and "/cart" not in text and "other.example" not in text
    assert "- [Pricing](https://www.shop.example/pricing)" in text  # ' | Shop Example' suffix removed
    assert text.index("## Main pages") < text.index("## Blog")


def test_readiness_audits_the_site_the_homepage_redirects_to():
    r = asyncio.run(audit.audit_readiness(www_site(), "shop.example"))
    assert r["url"] == O and r["finalUrl"] == W
    assert r["llmsTxt"]["present"] and r["llmsTxt"]["valid"] and r["sitemapFound"]
    assert r["aiAccess"]["robotsTxtState"] == "parsed"


def test_malformed_inputs_are_invalid_not_unreachable():
    targets, invalid = collect_inputs("crawler-access", {"websites": ["not a url", "shopify", "shop.example"]})
    assert targets == ["https://shop.example/"]
    assert [i["input"] for i in invalid] == ["not a url", "shopify"]
    assert "error" in asyncio.run(audit.audit_crawler_access(site(), "exa mple.com"))


def test_url_normalization():
    from readiness.fetch import normalize_page, normalize_site
    assert normalize_site("Shop.Example/some/page?x=1") == O
    assert normalize_site("http://[::1]:8080/x") == "http://[::1]:8080/"
    assert normalize_page("https://user:pw@shop.example:443/p?q=1#top") == O + "p?q=1"  # no credentials kept
    assert normalize_site("example.com:99999") is None and normalize_site("-bad.example") is None

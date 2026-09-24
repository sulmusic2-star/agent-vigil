"""Sitemaps, discovery files, AI policy labels, and the readiness score."""

import asyncio
import gzip

from readiness import access, discovery, robots, sitemap
from readiness.agents import AI_AGENTS
from readiness.fetch import FakeFetcher, Response
from readiness.score import ReadinessInputs, compute

URLSET = b"""<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://s.com/a</loc></url><url><loc>https://other.com/b</loc></url></urlset>"""


def test_parse_urlset_and_index():
    pages, children = sitemap.parse_sitemap(URLSET)
    assert pages == ["https://s.com/a", "https://other.com/b"] and children == []
    index = b"<sitemapindex><sitemap><loc>https://s.com/s1.xml</loc></sitemap></sitemapindex>"
    assert sitemap.parse_sitemap(index) == ([], ["https://s.com/s1.xml"])


def test_hostile_or_broken_xml_is_rejected():
    bomb = b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><urlset><url><loc>&lol;</loc></url></urlset>'
    assert sitemap.parse_sitemap(bomb) == ([], [])
    assert sitemap.parse_sitemap(b"<urlset><url>") == ([], [])


def test_gzip_sitemap():
    assert sitemap.parse_sitemap(gzip.compress(URLSET))[0][0] == "https://s.com/a"


def test_discover_follows_index_and_keeps_same_host():
    f = FakeFetcher({
        "https://s.com/sitemap.xml": (200, "application/xml",
                                      "<sitemapindex><sitemap><loc>https://s.com/s1.xml</loc></sitemap></sitemapindex>"),
        "https://s.com/s1.xml": (200, "application/xml", URLSET.decode()),
    })
    urls, checked = asyncio.run(sitemap.discover_urls(f, "https://s.com/", [], limit=10))
    assert urls == ["https://s.com/a"] and checked == ["https://s.com/sitemap.xml", "https://s.com/s1.xml"]


def test_discovery_ignores_html_fallbacks_and_bad_json():
    f = FakeFetcher({
        "https://s.com/.well-known/agent-card.json": (200, "application/json", '{"name": "S agent"}'),
        "https://s.com/.well-known/ai-plugin.json": (200, "text/html", "<!doctype html><html></html>"),
        "https://s.com/.well-known/tdmrep.json": (200, "application/json", '[{"location": "/*", "tdm-reservation": 1, "tdm-policy": "https://s.com/p"}]'),
        "https://s.com/ai.txt": (200, "text/plain", "{broken"),
        "https://s.com/.well-known/agent.json": (200, "application/json", "{not json"),
    })
    report = asyncio.run(discovery.check(f, "https://s.com/"))
    assert report.files["a2aAgentCard"].present
    assert not report.files["aiPluginManifest"].present and "HTML" in report.files["aiPluginManifest"].note
    assert not report.files["a2aAgentCardLegacy"].present
    assert report.files["aiTxt"].present  # plain text file, content not interpreted
    assert report.tdm_reserved is True and report.tdm_policy == "https://s.com/p"


def test_tdm_header_fallback():
    f = FakeFetcher({})
    home = Response(url="https://s.com/", final_url="https://s.com/", status=200,
                    headers={"tdm-reservation": "1", "content-type": "text/html"})
    report = asyncio.run(discovery.check(f, "https://s.com/", homepage=home))
    assert report.tdm_reserved is True


def _label(text):
    r = robots.parse(text)
    rows = access.agent_rows(r, list(AI_AGENTS))
    return access.classify(rows, r).code, rows


def test_policy_labels():
    assert _label("User-agent: *\nAllow: /\n")[0] == "open"
    training = [a.token for a in AI_AGENTS if a.purpose == "training"]
    blocks_training = "".join(f"User-agent: {t}\n" for t in training) + "Disallow: /\n"
    assert _label(blocks_training)[0] == "blocks-training"
    assert _label("User-agent: *\nDisallow: /\n")[0] == "blocks-all-ai"
    code, rows = _label("User-agent: GPTBot\nDisallow: /\nAllow: /blog/\n")
    gpt = next(r for r in rows if r["agent"] == "GPTBot")
    assert gpt["status"] == "limited" and gpt["decidingRule"] == "Disallow: /"


def test_unreachable_robots_label_and_wildcard_block():
    r = robots.from_response(500, "", None, False)
    rows = access.agent_rows(r, list(AI_AGENTS))
    assert access.classify(rows, r).code == "unreachable"
    assert access.wildcard_blocks_root(robots.parse("User-agent: *\nDisallow: /\n"))


def test_page_directives():
    d = access.page_directives({"robots": "noai, noimageai, max-snippet:50"}, {"x-robots-tag": "noindex"})
    assert d["noAiDirectives"] == ["noai", "noimageai"] and d["noindex"] and not d["nosnippet"]


def _perfect() -> ReadinessInputs:
    return ReadinessInputs(robots_state="parsed", explicit_ai_policy=True, answering_allowed=5, answering_total=5,
                           llms_present=True, llms_valid=True, llms_has_summary=True, llms_has_sections=True,
                           llms_full_present=True, homepage_checked=True, jsonld_present=True, org_or_website=True,
                           has_title=True, has_meta_description=True, has_canonical=True, https=True,
                           webmcp_tools=True, sitemap_ok=True, agent_card=True, rights_declared=True)


def test_perfect_site_scores_100():
    result = compute(_perfect())
    assert result["score"] == 100 and result["grade"] == "A" and result["fixes"] == [] and not result["partial"]


def test_partial_score_when_homepage_missing():
    inputs = _perfect()
    inputs.homepage_checked = False
    result = compute(inputs)
    assert result["partial"] and result["score"] == 100
    assert "Structured data" not in result["areas"]


def test_fixes_are_ranked_by_points():
    inputs = ReadinessInputs(robots_state="missing", https=True, homepage_checked=True, has_title=True)
    result = compute(inputs)
    points = [f["pointsAvailable"] for f in result["fixes"]]
    assert points == sorted(points, reverse=True)
    assert result["fixes"][0]["action"].startswith("Publish /llms.txt")
    assert result["grade"] == "F"

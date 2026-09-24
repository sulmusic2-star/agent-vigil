"""RFC 9309 behaviour that decides whether an AI crawler may fetch a site."""

from readiness import robots


def test_longest_match_wins():
    r = robots.parse("User-agent: *\nDisallow: /docs\nAllow: /docs/public\n")
    assert r.check("GPTBot", "/docs/public/page").allowed
    assert not r.check("GPTBot", "/docs/private").allowed


def test_allow_wins_a_tie():
    r = robots.parse("User-agent: *\nDisallow: /page\nAllow: /page\n")
    assert r.check("GPTBot", "/page").allowed


def test_wildcards_and_end_anchor():
    r = robots.parse("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*\n")
    assert not r.check("x", "/files/report.pdf").allowed
    assert r.check("x", "/files/report.pdf?download=1").allowed  # $ anchors the end
    assert not r.check("x", "/tmp-stuff").allowed


def test_agent_group_overrides_wildcard():
    r = robots.parse("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n")
    assert not r.check("GPTBot", "/").allowed
    assert r.check("ClaudeBot", "/").allowed
    assert r.check("ClaudeBot", "/").matched_group == "*"


def test_agent_matching_is_case_insensitive_and_ignores_version():
    r = robots.parse("User-agent: gptbot/1.1\nDisallow: /\n")
    assert not r.check("GPTBot", "/").allowed


def test_groups_for_same_agent_are_merged():
    r = robots.parse("User-agent: GPTBot\nDisallow: /a\n\nUser-agent: GPTBot\nDisallow: /b\n")
    assert not r.check("GPTBot", "/a").allowed
    assert not r.check("GPTBot", "/b").allowed


def test_consecutive_agents_share_a_group_even_with_sitemap_between():
    r = robots.parse("User-agent: GPTBot\nSitemap: https://x/s.xml\nUser-agent: CCBot\nDisallow: /\n")
    assert not r.check("GPTBot", "/").allowed
    assert not r.check("CCBot", "/").allowed
    assert r.sitemaps == ["https://x/s.xml"]


def test_empty_disallow_allows_everything():
    r = robots.parse("User-agent: *\nDisallow:\n")
    assert r.check("GPTBot", "/anything").allowed


def test_rules_before_any_group_are_ignored_and_reported():
    r = robots.parse("Disallow: /\nUser-agent: *\nAllow: /\n")
    assert r.check("GPTBot", "/").allowed
    assert any("before any user-agent" in i for i in r.issues)


def test_robots_txt_itself_is_always_allowed():
    r = robots.parse("User-agent: *\nDisallow: /\n")
    assert r.check("GPTBot", "/robots.txt").allowed


def test_no_matching_group_means_no_rules():
    r = robots.parse("User-agent: Googlebot\nDisallow: /\n")
    decision = r.check("GPTBot", "/")
    assert decision.allowed and decision.matched_group == "none"


def test_content_signals_in_group_and_global():
    r = robots.parse("Content-Signal: search=yes\nUser-agent: *\nContent-Signal: ai-train=no, ai-input=Yes\nAllow: /\n")
    assert r.global_signals == {"search": "yes"}
    assert r.signals_for("GPTBot") == {"search": "yes", "ai-train": "no", "ai-input": "yes"}


def test_fetch_outcomes_follow_rfc_9309():
    missing = robots.from_response(404, "", None, False)
    assert missing.state == "missing" and missing.check("GPTBot", "/private").allowed
    down = robots.from_response(503, "", None, False)
    assert down.state == "unreachable" and not down.check("GPTBot", "/").allowed
    network = robots.from_response(None, "", "ConnectError", False)
    assert network.state == "unreachable"
    html = robots.from_response(200, "<!doctype html><html></html>", None, True)
    assert html.state == "missing" and any("HTML" in i for i in html.issues)

"""AI readiness score (0-100) with a ranked fix list.

The score measures how reachable and machine-readable a site is for AI crawlers
and agents. It does not judge a site's policy: blocking AI search is a valid
choice, and the report says so, but it does make the site less visible in AI
answers, which is what this score measures.

Areas and points:
    AI access and policy     20   (robots.txt as declared)
    Crawler reach            20   (what crawlers actually get: firewall, JavaScript, Markdown)
    llms.txt                 10
    Structured data & basics 25   (needs the homepage)
    Agent actions            15   (WebMCP part needs the homepage)
    Discovery and rights     10

Weights follow what AI systems are known to use: content they can fetch and read
counts most; llms.txt, which few AI crawlers request, counts least.

When a check cannot run (for example the homepage cannot be fetched), it is left
out and the score is computed over the points that could be measured (``partial``).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ReadinessInputs:
    robots_state: str = "missing"            # parsed | missing | unreachable
    explicit_ai_policy: bool = False
    answering_allowed: int = 0
    answering_total: int = 0
    answering_blocked_names: list[str] = field(default_factory=list)
    llms_present: bool = False
    llms_valid: bool = False
    llms_first_error: str | None = None
    llms_has_summary: bool = False
    llms_has_sections: bool = False
    llms_full_present: bool = False
    homepage_checked: bool = False
    jsonld_present: bool = False
    org_or_website: bool = False
    jsonld_errors: int = 0
    has_title: bool = False
    has_meta_description: bool = False
    has_canonical: bool = False
    https: bool = False
    webmcp_tools: bool = False
    webmcp_first_issue: str | None = None
    sitemap_ok: bool = False
    agent_card: bool = False
    rights_declared: bool = False
    # Crawler reach (bot_access.crawler_reach); None / False when it did not run.
    content_js_status: str | None = None     # ok | thin | empty
    reach_tested: bool = False                # firewall comparison ran and was conclusive
    answering_tested: int = 0                 # AI search/assistant crawlers tested
    answering_turned_away: list[str] = field(default_factory=list)
    firewall_fix: str | None = None
    markdown_available: bool = False


@dataclass
class Check:
    key: str
    area: str
    points: int
    earned: float
    fix: str | None = None
    measured: bool = True


def _checks(i: ReadinessInputs) -> list[Check]:
    c: list[Check] = []
    # --- AI access and policy (20)
    robots_pts = {"parsed": 4, "missing": 2, "unreachable": 0}.get(i.robots_state, 0)
    robots_fix = None
    if i.robots_state == "missing":
        robots_fix = "Publish a robots.txt so AI crawlers get explicit rules"
    elif i.robots_state == "unreachable":
        robots_fix = ("Make robots.txt reachable: when it errors, compliant crawlers "
                      "treat the whole site as off-limits")
    c.append(Check("robots", "AI access and policy", 4, robots_pts, robots_fix))
    c.append(Check("explicitPolicy", "AI access and policy", 6, 6 if i.explicit_ai_policy else 0,
                   None if i.explicit_ai_policy else
                   "State your AI policy: add groups for AI crawlers (for example GPTBot, ClaudeBot) "
                   "or a Content-Signal line to robots.txt"))
    frac = (i.answering_allowed / i.answering_total) if i.answering_total else 1.0
    blocked = ", ".join(i.answering_blocked_names[:4])
    c.append(Check("answeringAccess", "AI access and policy", 10, round(10 * frac, 1),
                   None if frac >= 1 else
                   f"robots.txt blocks AI search and assistant crawlers ({blocked}); "
                   "allow them if you want to appear in AI answers"))
    # --- Crawler reach (20): what crawlers actually get
    js_pts = {"ok": 10, "thin": 5, "empty": 0}.get(i.content_js_status or "", 0)
    js_fix = None
    if i.content_js_status == "empty":
        js_fix = ("Render your homepage's content on the server: it is built by JavaScript, "
                  "and most AI crawlers don't run JavaScript, so they see an almost empty page")
    elif i.content_js_status == "thin":
        js_fix = ("Put your main content in the HTML the server sends: most of it appears only after "
                  "JavaScript runs, which most AI crawlers don't do")
    c.append(Check("contentWithoutJs", "Crawler reach", 10, js_pts, js_fix,
                   measured=i.content_js_status is not None))
    reached = (1 - len(i.answering_turned_away) / i.answering_tested) if i.answering_tested else 1.0
    c.append(Check("firewallAccess", "Crawler reach", 8, round(8 * reached, 1),
                   i.firewall_fix if i.answering_turned_away else None, measured=i.reach_tested))
    c.append(Check("markdown", "Crawler reach", 2, 2 if i.markdown_available else 0,
                   None if i.markdown_available else
                   "Offer a Markdown version of key pages: answer 'Accept: text/markdown' requests "
                   "or add <link rel=\"alternate\" type=\"text/markdown\"> to the page",
                   measured=i.content_js_status is not None))
    # --- llms.txt (10)
    if not i.llms_present:
        c.append(Check("llmsTxt", "llms.txt", 6, 0,
                       "Publish /llms.txt: an H1 title, a one-line '>' summary, and '## Section' lists of your key links"))
    else:
        c.append(Check("llmsTxt", "llms.txt", 6, 6 if i.llms_valid else 2,
                       None if i.llms_valid else f"Fix /llms.txt: {i.llms_first_error or 'structure errors'}"))
    c.append(Check("llmsSummary", "llms.txt", 2, 2 if i.llms_has_summary else 0,
                   None if (i.llms_has_summary or not i.llms_present) else
                   "Add a '> one-line summary' under the llms.txt title"))
    c.append(Check("llmsSections", "llms.txt", 1, 1 if i.llms_has_sections else 0,
                   None if (i.llms_has_sections or not i.llms_present) else
                   "Add '## Section' headings with lists of your most useful links to llms.txt"))
    c.append(Check("llmsFull", "llms.txt", 1, 1 if i.llms_full_present else 0,
                   None if i.llms_full_present else
                   "Optionally publish /llms-full.txt with the full text of your key pages"))
    # --- Structured data and page basics (25), needs the homepage
    home = i.homepage_checked
    c.append(Check("jsonLd", "Structured data", 8, 8 if i.jsonld_present else 0,
                   None if i.jsonld_present else "Add schema.org JSON-LD to your homepage", measured=home))
    c.append(Check("orgOrWebsite", "Structured data", 7, 7 if i.org_or_website else 0,
                   None if i.org_or_website else
                   "Add Organization and WebSite JSON-LD so AI answers can identify your brand", measured=home))
    valid_pts = 5 if (i.jsonld_present and i.jsonld_errors == 0) else 0
    c.append(Check("jsonLdValid", "Structured data", 5, valid_pts,
                   f"Fix JSON-LD syntax errors ({i.jsonld_errors} block(s) failed to parse)" if i.jsonld_errors else None,
                   measured=home))
    basics = (2 if i.has_title else 0) + (2 if i.has_meta_description else 0) + (1 if i.has_canonical else 0)
    missing = [n for n, ok in (("a title", i.has_title), ("a meta description", i.has_meta_description),
                                ("a canonical link", i.has_canonical)) if not ok]
    c.append(Check("pageBasics", "Structured data", 5, basics,
                   ("Add " + ", ".join(missing) + " to your homepage") if missing else None, measured=home))
    # --- Agent actions (15)
    c.append(Check("https", "Agent actions", 4, 4 if i.https else 0,
                   None if i.https else "Serve the site over HTTPS; WebMCP and many agents require it"))
    c.append(Check("webmcp", "Agent actions", 8, 8 if i.webmcp_tools else 0,
                   None if i.webmcp_tools else
                   "Expose key actions (search, booking, contact) to AI agents as WebMCP tools: "
                   "add toolname and tooldescription attributes to the form", measured=home))
    quality = 3 if (i.webmcp_tools and not i.webmcp_first_issue) else 0
    c.append(Check("webmcpQuality", "Agent actions", 3, quality,
                   f"Improve your WebMCP tools: {i.webmcp_first_issue}" if (i.webmcp_tools and i.webmcp_first_issue) else None,
                   measured=home))
    # --- Discovery and rights (10)
    c.append(Check("sitemap", "Discovery and rights", 5, 5 if i.sitemap_ok else 0,
                   None if i.sitemap_ok else "Publish a sitemap.xml and list it in robots.txt with a 'Sitemap:' line"))
    c.append(Check("agentCard", "Discovery and rights", 3, 3 if i.agent_card else 0,
                   None if i.agent_card else
                   "If you offer an agent or API, publish an A2A agent card at /.well-known/agent-card.json"))
    c.append(Check("rights", "Discovery and rights", 2, 2 if i.rights_declared else 0,
                   None if i.rights_declared else
                   "Declare machine-readable AI usage rights (a Content-Signal line, an RSL license "
                   "or /.well-known/tdmrep.json)"))
    return c


def grade_for(score: int) -> str:
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 55:
        return "C"
    if score >= 40:
        return "D"
    return "F"


def compute(i: ReadinessInputs, *, max_fixes: int = 6) -> dict:
    checks = _checks(i)
    measured = [c for c in checks if c.measured]
    possible = sum(c.points for c in measured)
    earned = sum(c.earned for c in measured)
    score = round(100 * earned / possible) if possible else 0
    areas: dict[str, dict[str, float]] = {}
    for c in measured:
        slot = areas.setdefault(c.area, {"earned": 0.0, "possible": 0})
        slot["earned"] += c.earned
        slot["possible"] += c.points
    for slot in areas.values():
        slot["earned"] = round(slot["earned"], 1)
    fixes = sorted((c for c in measured if c.fix and c.earned < c.points),
                   key=lambda c: c.points - c.earned, reverse=True)
    return {
        "score": score,
        "grade": grade_for(score),
        "partial": len(measured) < len(checks),
        "areas": areas,
        "fixes": [
            {"priority": n + 1, "area": c.area, "action": c.fix,
             "pointsAvailable": round(c.points - c.earned, 1)}
            for n, c in enumerate(fixes[:max_fixes])
        ],
    }

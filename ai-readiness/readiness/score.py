"""AI readiness score (0-100) with a ranked fix list.

The score measures how reachable and machine-readable a site is for AI crawlers
and agents. It does not judge a site's policy: blocking AI search is a valid
choice, and the report says so, but it does make the site less visible in AI
answers, which is what this score measures.

Areas and points:
    AI access and policy     25
    llms.txt                 20
    Structured data & basics 25   (needs the homepage)
    Agent actions            20   (WebMCP part needs the homepage)
    Discovery and rights     10

When the homepage cannot be fetched, checks that need it are left out and the
score is computed over the points that could be measured (``partial``).
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
    # --- AI access and policy (25)
    robots_pts = {"parsed": 5, "missing": 2, "unreachable": 0}.get(i.robots_state, 0)
    robots_fix = None
    if i.robots_state == "missing":
        robots_fix = "Publish a robots.txt so AI crawlers get explicit rules"
    elif i.robots_state == "unreachable":
        robots_fix = ("Make robots.txt reachable: when it errors, compliant crawlers "
                      "treat the whole site as off-limits")
    c.append(Check("robots", "AI access and policy", 5, robots_pts, robots_fix))
    c.append(Check("explicitPolicy", "AI access and policy", 8, 8 if i.explicit_ai_policy else 0,
                   None if i.explicit_ai_policy else
                   "State your AI policy: add groups for AI crawlers (for example GPTBot, ClaudeBot) "
                   "or a Content-Signal line to robots.txt"))
    frac = (i.answering_allowed / i.answering_total) if i.answering_total else 1.0
    blocked = ", ".join(i.answering_blocked_names[:4])
    c.append(Check("answeringAccess", "AI access and policy", 12, round(12 * frac, 1),
                   None if frac >= 1 else
                   f"robots.txt blocks AI search and assistant crawlers ({blocked}); "
                   "allow them if you want to appear in AI answers"))
    # --- llms.txt (20)
    if not i.llms_present:
        c.append(Check("llmsTxt", "llms.txt", 12, 0,
                       "Publish /llms.txt: an H1 title, a one-line '>' summary, and '## Section' lists of your key links"))
    else:
        c.append(Check("llmsTxt", "llms.txt", 12, 12 if i.llms_valid else 4,
                       None if i.llms_valid else f"Fix /llms.txt: {i.llms_first_error or 'structure errors'}"))
    c.append(Check("llmsSummary", "llms.txt", 3, 3 if i.llms_has_summary else 0,
                   None if (i.llms_has_summary or not i.llms_present) else
                   "Add a '> one-line summary' under the llms.txt title"))
    c.append(Check("llmsSections", "llms.txt", 3, 3 if i.llms_has_sections else 0,
                   None if (i.llms_has_sections or not i.llms_present) else
                   "Add '## Section' headings with lists of your most useful links to llms.txt"))
    c.append(Check("llmsFull", "llms.txt", 2, 2 if i.llms_full_present else 0,
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
    # --- Agent actions (20)
    c.append(Check("https", "Agent actions", 6, 6 if i.https else 0,
                   None if i.https else "Serve the site over HTTPS; WebMCP and many agents require it"))
    c.append(Check("webmcp", "Agent actions", 10, 10 if i.webmcp_tools else 0,
                   None if i.webmcp_tools else
                   "Expose key actions (search, booking, contact) to AI agents as WebMCP tools: "
                   "add toolname and tooldescription attributes to the form", measured=home))
    quality = 4 if (i.webmcp_tools and not i.webmcp_first_issue) else 0
    c.append(Check("webmcpQuality", "Agent actions", 4, quality,
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
                   "Declare machine-readable AI usage rights (a Content-Signal line or /.well-known/tdmrep.json)"))
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

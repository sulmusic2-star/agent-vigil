"""Entry points used by the Apify actors. Each returns one JSON-ready dict."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from . import bot_access, discovery, llms_txt, sitemap, structured_data, webmcp
from .access import agent_rows, classify, has_ai_specific_rules, page_directives, wildcard_blocks_root
from .agents import agents_with_extras
from .fetch import Fetcher, normalize_page, normalize_site, same_host
from .html_scan import scan_html
from .score import ReadinessInputs, compute
from .site import SiteContext

NON_HTML_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".zip", ".mp4", ".mp3",
                ".xml", ".json", ".txt", ".css", ".js", ".ico", ".woff", ".woff2")

# Pages that don't belong in an llms.txt: sign-in, carts, search results, feeds.
UTILITY_SEGMENTS = frozenset({
    "login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "logout", "log-out",
    "signout", "sign-out", "account", "accounts", "my-account", "cart", "basket", "checkout",
    "password", "reset-password", "forgot-password", "auth", "oauth", "sso", "admin", "wp-admin",
    "wp-login.php", "search", "feed", "cdn-cgi",
})


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _host(url: str) -> str:
    return urlsplit(url).hostname or ""


def _invalid(value: str) -> dict[str, Any]:
    return {"url": value, "error": "not a valid http(s) URL or domain", "checkedAt": _now()}


def _site_signals(ctx_robots) -> dict[str, str]:
    signals = dict(ctx_robots.global_signals)
    signals.update(ctx_robots.signals_for("*"))
    return signals


def _with_signals(text: str, signals: dict[str, str]) -> str:
    """Add declared Content Signals to a policy sentence, e.g. '...; declares ai-train=no'."""

    if not signals:
        return text
    return f"{text}; declares " + ", ".join(f"{k}={v}" for k, v in sorted(signals.items()))


# --- AI crawler access ------------------------------------------------------

async def audit_crawler_access(fetcher: Fetcher, url: str, *, extra_agents: list[str] | tuple[str, ...] = (),
                               check_page: bool = True, respect_robots: bool = True,
                               test_firewall: bool = True) -> dict[str, Any]:
    origin = normalize_site(url)
    if origin is None:
        return _invalid(url)
    ctx = SiteContext(origin, fetcher, respect_robots)
    robots = await ctx.robots()
    agents = agents_with_extras(extra_agents)
    rows = agent_rows(robots, agents)
    policy = classify(rows, robots)
    training = [r for r in rows if r["purpose"] == "training"]
    answering = [r for r in rows if r["purpose"] in {"search", "user"}]

    directives = None
    home_resp = None
    scan = None
    reach = None
    if check_page or test_firewall:
        home_resp, scan, _ = await ctx.homepage()
    if check_page:
        directives = page_directives(scan.meta if scan else {}, home_resp.headers if home_resp else {})
    if test_firewall and scan is not None and home_resp is not None and home_resp.ok:
        reach = await bot_access.crawler_reach(fetcher, home_resp.final_url, robots, scan)
    tdm_resp = await fetcher.get(urljoin(origin, "/.well-known/tdmrep.json"), max_bytes=200_000)
    tdm = discovery._judge("tdmrep", tdm_resp)
    reserved, tdm_policy = discovery._tdm_from_file(tdm.data) if tdm.present else (None, None)
    if reserved is None and home_resp is not None and "tdm-reservation" in home_resp.headers:
        reserved = home_resp.headers["tdm-reservation"].strip() == "1"
        tdm_policy = home_resp.headers.get("tdm-policy")

    signals = _site_signals(robots)
    reachable = (ctx._robots_resp is not None and ctx._robots_resp.status is not None) or (
        home_resp is not None and home_resp.status is not None)
    return {
        "url": origin,
        "domain": _host(origin),
        "checkedAt": _now(),
        "reachable": reachable,
        "policy": policy.code,
        "policySummary": _with_signals(policy.text, signals),
        "trainingCrawlersBlocked": f"{sum(r['status'] != 'allowed' for r in training)}/{len(training)}",
        "searchAndAssistantCrawlersBlocked": f"{sum(r['status'] != 'allowed' for r in answering)}/{len(answering)}",
        "blocksAllBots": wildcard_blocks_root(robots),
        "hasAiSpecificRules": has_ai_specific_rules(robots, agents),
        "contentSignals": signals or None,
        "tdmReservation": reserved,
        "tdmPolicy": tdm_policy,
        "pageDirectives": directives,
        "actualAccessSummary": reach["summary"] if reach else None,
        "rslLicenses": robots.licenses + (scan.license_links if scan else []),
        "actualAccess": None if reach is None else {
            "summary": reach["summary"],
            "edgeProvider": reach["firewall"]["edgeProvider"],
            "turnedAway": reach["firewall"]["turnedAway"],
            "inconclusive": reach["firewall"]["inconclusive"],
            "fix": bot_access.firewall_fix(reach),
        },
        "crawlerReach": reach,
        "robotsTxt": {
            "state": robots.state,
            "httpStatus": ctx._robots_resp.status if ctx._robots_resp else None,
            "groups": len(robots.groups),
            "sitemaps": robots.sitemaps,
            "issues": robots.issues,
        },
        "agents": rows,
        "notes": ctx.notes,
    }


# --- llms.txt ---------------------------------------------------------------

async def _llms(fetcher: Fetcher, origin: str) -> tuple[llms_txt.LlmsTxtReport, bool, str | None, bool]:
    resp = await fetcher.get(urljoin(origin, "/llms.txt"), max_bytes=1_000_000)
    note = None
    if resp.ok:
        report = llms_txt.validate(resp.text, served_as_html=resp.looks_like_html())
    else:
        report = llms_txt.LlmsTxtReport(present=False)
        note = resp.error if resp.status is None else f"HTTP {resp.status}"
    full = await fetcher.get(urljoin(origin, "/llms-full.txt"), max_bytes=100_000)
    full_present = bool(full.ok and not full.looks_like_html() and full.text.strip())
    # The site answered if either request got any HTTP status back.
    reachable = resp.status is not None or full.status is not None
    return report, full_present, note, reachable


async def audit_llms_txt(fetcher: Fetcher, url: str) -> dict[str, Any]:
    origin = normalize_site(url)
    if origin is None:
        return _invalid(url)
    report, full_present, note, reachable = await _llms(fetcher, origin)
    return {
        "url": origin,
        "domain": _host(origin),
        "checkedAt": _now(),
        "reachable": reachable,
        "llmsTxtUrl": urljoin(origin, "/llms.txt"),
        "present": report.present,
        "valid": report.valid,
        "errors": sum(i.severity == "error" for i in report.issues),
        "warnings": sum(i.severity == "warning" for i in report.issues),
        "title": report.title,
        "summary": report.summary,
        "sectionCount": len(report.sections),
        "linkCount": report.link_count,
        "sections": [{"name": s.name, "links": len(s.links)} for s in report.sections],
        "issues": [i.as_dict() for i in report.issues],
        "sizeBytes": report.size_bytes,
        "llmsFullTxt": full_present,
        "fetchNote": note,
    }


def _site_name(scan, host: str) -> str:
    if scan is None:
        return host
    explicit = scan.meta.get("og:site_name") or scan.meta.get("application-name")
    if explicit:
        return explicit.strip() or host
    name = scan.title or host
    # Homepage titles are usually "Brand | Tagline"; keep the brand part.
    for sep in (" | ", " - ", " – ", " — ", " · ", ": "):
        if sep in name:
            name = name.split(sep)[0]
            break
    return name.strip() or host


def _clean_link(base: str, site: str, href: str) -> str | None:
    """Absolute URL for an on-site HTML page link, or None."""

    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
        return None
    absolute = urljoin(base, href)
    parts = urlsplit(absolute)
    if parts.scheme not in {"http", "https"} or not same_host(absolute, site):
        return None
    if parts.path.lower().endswith(NON_HTML_EXT):
        return None
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def _is_utility(url: str) -> bool:
    parts = urlsplit(url)
    return bool(parts.query) or any(seg.lower() in UTILITY_SEGMENTS for seg in parts.path.split("/") if seg)


async def generate_llms_txt(fetcher: Fetcher, url: str, *, max_pages: int = 40,
                            respect_robots: bool = True) -> dict[str, Any]:
    origin = normalize_site(url)
    if origin is None:
        return _invalid(url)
    ctx = SiteContext(origin, fetcher, respect_robots)
    home, scan, home_reason = await ctx.homepage()
    site = ctx.final_origin()
    if site != origin:  # e.g. example.com -> www.example.com
        ctx = ctx.moved_to(site)
    robots = await ctx.robots()
    home_url = (normalize_page(home.final_url) if home is not None and home.ok else None) or site
    sitemap_urls, checked = await sitemap.discover_urls(fetcher, site, robots.sitemaps, limit=max_pages * 4)

    # Homepage links come first: they are the pages the site itself puts in front of
    # visitors. Sitemap URLs fill the remaining room. Shallow pages before deep ones.
    ranked: list[tuple[int, int, int, str]] = []
    seen = {home_url.rstrip("/"), site.rstrip("/")}
    for rank, source in enumerate((scan.links if scan is not None else [], sitemap_urls)):
        for index, href in enumerate(source):
            link = _clean_link(home_url, site, href)
            if link and not _is_utility(link) and link.rstrip("/") not in seen:
                seen.add(link.rstrip("/"))
                ranked.append((rank, urlsplit(link).path.strip("/").count("/"), index, link))
    chosen = [link for *_, link in sorted(ranked)[:max_pages]]

    slots = asyncio.Semaphore(5)

    async def describe(page_url: str) -> dict[str, str] | None:
        async with slots:
            resp, skipped = await ctx.fetch_page(page_url, max_bytes=1_500_000)
        if skipped or resp is None or not resp.ok or not resp.looks_like_html():
            return None
        final = normalize_page(resp.final_url) or page_url
        if not same_host(final, site) or _is_utility(final):
            return None  # redirected off the site or to a sign-in page
        page = scan_html(resp.text)
        return {
            "url": final,
            "title": page.meta.get("og:title") or page.title or "",
            "description": page.meta.get("description") or page.meta.get("og:description") or "",
        }

    pages = []
    if scan is not None:
        pages.append({"url": home_url, "title": "Home", "description": scan.meta.get("description", "")})
    listed = {home_url.rstrip("/")}
    for page in await asyncio.gather(*(describe(u) for u in chosen)):
        if page and page["url"].rstrip("/") not in listed:  # two links can redirect to one page
            listed.add(page["url"].rstrip("/"))
            pages.append(page)
    summary = (scan.meta.get("description") or scan.meta.get("og:description") or "") if scan else ""
    text = llms_txt.generate(_site_name(scan, _host(site)), summary, pages)
    draft = llms_txt.validate(text)
    existing, _, _, _ = await _llms(fetcher, site)
    return {
        "url": origin,
        "finalUrl": home_url,
        "domain": _host(origin),
        "checkedAt": _now(),
        "reachable": (ctx._robots_resp is not None and ctx._robots_resp.status is not None) or (home is not None and home.status is not None),
        "pagesIncluded": len(pages),
        "sitemapsChecked": checked,
        "draftValid": draft.valid,
        "existingLlmsTxt": existing.present,
        "existingLlmsTxtValid": existing.valid if existing.present else None,
        "llmsTxt": text,
        "notes": ctx.notes + ([f"homepage: {home_reason}"] if home_reason else []),
    }


# --- product pages ----------------------------------------------------------

async def audit_product_page(fetcher: Fetcher, url: str, *, respect_robots: bool = True) -> dict[str, Any]:
    page_url = normalize_page(url)
    origin = normalize_site(url)
    if page_url is None or origin is None:
        return _invalid(url)
    ctx = SiteContext(origin, fetcher, respect_robots)
    resp, skipped = await ctx.fetch_page(page_url)
    base = {"url": page_url, "domain": _host(page_url), "checkedAt": _now()}
    if skipped:
        return {**base, "skipped": skipped}
    if resp is None or not resp.ok:
        return {**base, "reachable": bool(resp is not None and resp.status is not None),
                "error": (resp.error if resp else None) or f"HTTP {resp.status if resp else '?'}"}
    scan = scan_html(resp.text)
    data = structured_data.extract(scan.json_ld)
    products = structured_data.products_in(data)
    checks = [structured_data.check_product(p) for p in products[:5]]
    best = max(checks, key=lambda c: c.score) if checks else None
    og_product = scan.meta.get("og:type", "").lower() == "product"
    if best is None:
        fixes = ["Add Product JSON-LD with name, image, brand, a GTIN/MPN/SKU, and offers "
                 "(price, priceCurrency, availability) so AI shopping agents can read this product"]
    else:
        fixes = [f"Add {m} to the Product JSON-LD" for m in best.missing[:6]]
    return {
        **base,
        "reachable": True,
        "productsFound": len(products),
        "score": best.score if best else 0,
        "productName": best.name if best else None,
        "present": best.present if best else [],
        "missing": best.missing if best else [],
        "jsonLdBlocks": len(scan.json_ld),
        "jsonLdErrors": data.parse_errors,
        "types": data.types,
        "openGraphProduct": og_product,
        "fixes": fixes,
    }


# --- full readiness audit ---------------------------------------------------

async def _same_site_scripts(ctx: SiteContext, srcs: list[str], limit: int) -> list[str]:
    host = _host(ctx.origin)
    base = host[4:] if host.startswith("www.") else host
    urls = []
    for src in srcs:
        absolute = urljoin(ctx.origin, src)
        h = _host(absolute)
        if h and (h == host or h == base or h.endswith("." + base)) and absolute not in urls:
            urls.append(absolute)
    texts = []
    for script_url in urls[:limit]:
        if not await ctx.may_fetch(script_url):
            continue
        resp = await ctx.fetcher.get(script_url, max_bytes=1_500_000)
        if resp.ok and not resp.looks_like_html():
            texts.append(resp.text)
    return texts


async def _sitemap_ok(fetcher: Fetcher, origin: str, robots_sitemaps: list[str]) -> bool:
    urls, _ = await sitemap.discover_urls(fetcher, origin, robots_sitemaps, limit=1)
    return bool(urls)


async def audit_readiness(fetcher: Fetcher, url: str, *, extra_agents: list[str] | tuple[str, ...] = (),
                          respect_robots: bool = True, scan_scripts: bool = True,
                          max_scripts: int = 6, test_reach: bool = True) -> dict[str, Any]:
    origin = normalize_site(url)
    if origin is None:
        return _invalid(url)
    ctx = SiteContext(origin, fetcher, respect_robots)
    home, scan, home_reason = await ctx.homepage()
    site = ctx.final_origin()
    if site != origin:  # e.g. example.com -> www.example.com: audit the site agents land on
        ctx = ctx.moved_to(site)
    robots = await ctx.robots()
    agents = agents_with_extras(extra_agents)
    rows = agent_rows(robots, agents)
    policy = classify(rows, robots)
    homepage_ok = scan is not None and home is not None and home.ok

    (llms_report, llms_full, _, _), disc, sitemap_ok = await asyncio.gather(
        _llms(fetcher, site),
        discovery.check(fetcher, site, homepage=home, meta=scan.meta if scan else None),
        _sitemap_ok(fetcher, site, robots.sitemaps),
    )

    data = structured_data.extract(scan.json_ld) if homepage_ok else structured_data.StructuredData()
    scripts = await _same_site_scripts(ctx, scan.script_srcs, max_scripts) if (homepage_ok and scan_scripts) else []
    final_url = home.final_url if (home is not None and home.ok) else origin
    mcp = webmcp.analyze(scan, final_url=final_url, external_scripts=scripts) if homepage_ok else None
    reach = await bot_access.crawler_reach(fetcher, final_url, robots, scan) if (homepage_ok and test_reach) else None
    reach_rows = reach["firewall"]["agents"] if reach else []
    first_tool_issue = None
    if mcp is not None:
        for tool in mcp.declarative_tools:
            if tool.issues:
                first_tool_issue = f"tool '{tool.name or '?'}': {tool.issues[0]}"
                break

    answering = [r for r in rows if r["purpose"] in {"search", "user"}]
    signals = _site_signals(robots)
    explicit = has_ai_specific_rules(robots, agents) or bool(signals) or disc.tdm_reserved is not None
    inputs = ReadinessInputs(
        robots_state=robots.state,
        explicit_ai_policy=explicit,
        answering_allowed=sum(r["status"] == "allowed" for r in answering),
        answering_total=len(answering),
        answering_blocked_names=[r["agent"] for r in answering if r["status"] != "allowed"],
        llms_present=llms_report.present,
        llms_valid=llms_report.valid,
        llms_first_error=next((i.message for i in llms_report.issues if i.severity == "error"), None),
        llms_has_summary=bool(llms_report.summary),
        llms_has_sections=llms_report.link_count > 0,
        llms_full_present=llms_full or disc.files["llmsFullTxt"].present,
        homepage_checked=homepage_ok,
        jsonld_present=bool(data.entities),
        org_or_website=any(t in data.types for t in ("Organization", "WebSite", "LocalBusiness", "Corporation")),
        jsonld_errors=data.parse_errors,
        has_title=bool(scan.title) if scan else False,
        has_meta_description=bool(scan.meta.get("description")) if scan else False,
        has_canonical=bool(scan.canonical) if scan else False,
        https=final_url.lower().startswith("https://"),
        webmcp_tools=bool(mcp and mcp.has_tools),
        webmcp_first_issue=first_tool_issue,
        sitemap_ok=sitemap_ok,
        agent_card=any(disc.files[k].present for k in ("a2aAgentCard", "a2aAgentCardLegacy", "aiPluginManifest")),
        rights_declared=(bool(signals) or disc.tdm_reserved is not None or disc.files["aiTxt"].present
                         or bool(robots.licenses) or bool(scan and scan.license_links)),
        content_js_status=reach["contentWithoutJavaScript"]["status"] if reach else None,
        reach_tested=bool(reach and not reach["firewall"]["inconclusive"]),
        answering_tested=sum(1 for r in reach_rows if r["purpose"] in {"search", "user"} and r["result"] != "not-tested"),
        answering_turned_away=reach["firewall"]["answeringCrawlersTurnedAway"] if reach else [],
        firewall_fix=bot_access.firewall_fix(reach) if reach else None,
        markdown_available=bool(reach and (reach["markdown"]["acceptHeader"] or reach["markdown"]["alternateLink"])),
    )
    result = compute(inputs)
    summary_bits = [_with_signals(policy.text, signals)]
    if reach and reach["firewall"]["turnedAway"] and not reach["firewall"]["inconclusive"]:
        summary_bits.append("firewall turns away " + ", ".join(reach["firewall"]["turnedAway"]))
    if reach and reach["contentWithoutJavaScript"]["status"] == "empty":
        summary_bits.append("homepage content needs JavaScript")
    summary_bits += ["llms.txt valid" if llms_report.valid else ("llms.txt has errors" if llms_report.present else "no llms.txt"),
                     ("WebMCP tools found" if (mcp and mcp.has_tools) else "no WebMCP tools") if homepage_ok else "homepage not checked"]
    return {
        "url": origin,
        "finalUrl": final_url,
        "domain": _host(origin),
        "checkedAt": _now(),
        "reachable": (ctx._robots_resp is not None and ctx._robots_resp.status is not None) or (home is not None and home.status is not None),
        "score": result["score"],
        "grade": result["grade"],
        "partialScore": result["partial"],
        "summary": "; ".join(summary_bits),
        "topFix": result["fixes"][0]["action"] if result["fixes"] else None,
        "fixes": result["fixes"],
        "areas": result["areas"],
        "aiAccess": {
            "policy": policy.code,
            "policySummary": _with_signals(policy.text, signals),
            "blocksAllBots": wildcard_blocks_root(robots),
            "contentSignals": signals or None,
            "tdmReservation": disc.tdm_reserved,
            "robotsTxtState": robots.state,
            "agents": rows,
        },
        "llmsTxt": {
            "present": llms_report.present,
            "valid": llms_report.valid,
            "linkCount": llms_report.link_count,
            "issues": [i.as_dict() for i in llms_report.issues],
            "llmsFullTxt": inputs.llms_full_present,
        },
        "webmcp": None if mcp is None else {
            "secureContext": mcp.secure_context,
            "declarativeTools": [
                {"name": t.name, "description": t.description, "params": t.params,
                 "paramsDescribed": t.params_described, "autosubmit": t.autosubmit, "issues": t.issues}
                for t in mcp.declarative_tools
            ],
            "imperativeApiDetected": mcp.imperative_api_detected,
            "imperativeToolNames": mcp.imperative_tool_names,
            "scriptsScanned": mcp.scripts_scanned,
            "issues": mcp.issues,
        },
        "structuredData": {"types": data.types, "entities": len(data.entities), "parseErrors": data.parse_errors}
        if homepage_ok else None,
        "crawlerReach": reach,
        "discovery": {k: {"present": v.present, "note": v.note} for k, v in disc.files.items()},
        "sitemapFound": sitemap_ok,
        "notes": ctx.notes + ([f"homepage: {home_reason}"] if home_reason and not ctx.notes else []),
    }

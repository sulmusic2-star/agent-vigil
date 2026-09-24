"""Per-agent AI access, the site's overall AI policy, and page-level directives."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .agents import AIAgent
from .robots import RobotsTxt

AI_META_TOKENS = ("noai", "noimageai")


@dataclass(frozen=True)
class PolicyLabel:
    code: str
    text: str


def agent_rows(robots: RobotsTxt, agents: list[AIAgent]) -> list[dict[str, Any]]:
    rows = []
    for agent in agents:
        decision = robots.check(agent.token, "/")
        rules, label = robots.rules_for(agent.token)
        opens_paths = any(r.allow and r.pattern not in ("", "/") for r in rules)
        restricted = [r.pattern for r in rules if not r.allow and r.pattern]
        if robots.state == "unreachable":
            status = "blocked"
        elif decision.allowed:
            status = "allowed"
        elif opens_paths:
            status = "limited"
        else:
            status = "blocked"
        rule_text = None
        if decision.rule is not None:
            rule_text = f"{'Allow' if decision.rule.allow else 'Disallow'}: {decision.rule.pattern}"
        rows.append({
            "agent": agent.token,
            "vendor": agent.vendor,
            "purpose": agent.purpose,
            "status": status,
            "matchedGroup": label if robots.state == "parsed" else robots.state,
            "decidingRule": rule_text,
            "restrictedPaths": len(restricted) if status == "allowed" else None,
        })
    return rows


def classify(rows: list[dict[str, Any]], robots: RobotsTxt) -> PolicyLabel:
    if robots.state == "unreachable":
        return PolicyLabel("unreachable", "robots.txt unreachable, so compliant crawlers treat the site as fully disallowed")
    training = [r for r in rows if r["purpose"] == "training"]
    answering = [r for r in rows if r["purpose"] in {"search", "user"}]
    t_blocked = sum(1 for r in training if r["status"] != "allowed")
    a_blocked = sum(1 for r in answering if r["status"] != "allowed")
    if t_blocked == 0 and a_blocked == 0:
        return PolicyLabel("open", "Open to AI crawlers")
    if training and t_blocked == len(training) and a_blocked == 0:
        return PolicyLabel("blocks-training", "Blocks AI training, allows AI search and assistants")
    if training and answering and t_blocked == len(training) and a_blocked == len(answering):
        return PolicyLabel("blocks-all-ai", "Blocks AI training and AI search")
    if training and t_blocked * 2 >= len(training) and a_blocked * 2 < max(1, len(answering)):
        return PolicyLabel("mostly-blocks-training", "Mostly blocks AI training, mostly allows AI search")
    if answering and a_blocked == len(answering) and t_blocked < len(training):
        return PolicyLabel("blocks-search", "Blocks AI search and assistants but not all training crawlers")
    return PolicyLabel("mixed", "Mixed AI crawler rules")


def has_ai_specific_rules(robots: RobotsTxt, agents: list[AIAgent]) -> bool:
    tokens = {a.token.lower() for a in agents}
    for group in robots.groups:
        for name in group.agents:
            if name.strip().split("/", 1)[0].strip().lower() in tokens:
                return True
    return False


def wildcard_blocks_root(robots: RobotsTxt) -> bool:
    return robots.state == "parsed" and not robots.check("*-generic-bot-*", "/").allowed


def page_directives(meta: dict[str, str], headers: dict[str, str]) -> dict[str, Any]:
    """AI-relevant robots directives on the page itself (meta tags and X-Robots-Tag)."""

    meta_values: list[str] = []
    for key in ("robots", "googlebot", "bingbot"):
        if key in meta:
            meta_values += [v.strip().lower() for v in meta[key].split(",") if v.strip()]
    header_values = [v.strip().lower() for v in headers.get("x-robots-tag", "").split(",") if v.strip()]
    combined = meta_values + header_values
    return {
        "metaRobots": meta_values,
        "xRobotsTag": header_values,
        "noAiDirectives": sorted({t for t in combined if t in AI_META_TOKENS}),
        "noindex": "noindex" in combined or "none" in combined,
        "nosnippet": "nosnippet" in combined,
    }

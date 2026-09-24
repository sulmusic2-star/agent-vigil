"""robots.txt parsing and matching per RFC 9309, plus Content Signals.

Implements the parts of RFC 9309 that decide access:

* groups start with one or more ``user-agent`` lines; rules before any group are
  ignored; several groups naming the same agent are merged;
* an agent uses its own group(s) if any match its product token
  (case-insensitive), otherwise the ``*`` group(s), otherwise no rules apply;
* the longest matching rule wins, and ``allow`` wins a tie;
* ``*`` matches any sequence and a trailing ``$`` anchors the end;
* ``/robots.txt`` itself is always allowed.

Fetch outcomes follow RFC 9309 section 2.3.1: a 4xx means "no restrictions", a
5xx or network failure means "assume everything is disallowed".

Content Signals (``Content-Signal: search=yes, ai-train=no``) are the
machine-readable preferences popularised by Cloudflare's Content Signals Policy.
They express how content may be *used*, which robots.txt rules cannot.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_ROBOTS_BYTES = 512 * 1024  # RFC 9309 asks parsers to handle at least 500 KiB


@dataclass(frozen=True)
class Rule:
    allow: bool
    pattern: str
    line: int

    def regex(self) -> re.Pattern[str]:
        pattern = self.pattern
        anchored = pattern.endswith("$")
        if anchored:
            pattern = pattern[:-1]
        body = ".*".join(re.escape(part) for part in pattern.split("*"))
        return re.compile(body + ("$" if anchored else ""))

    @property
    def specificity(self) -> int:
        return len(self.pattern.encode("utf-8"))


@dataclass
class Group:
    agents: list[str]
    rules: list[Rule] = field(default_factory=list)
    signals: dict[str, str] = field(default_factory=dict)
    line: int = 0


@dataclass(frozen=True)
class Decision:
    allowed: bool
    rule: Rule | None
    matched_group: str  # agent token, "*", or "none"


@dataclass
class RobotsTxt:
    groups: list[Group] = field(default_factory=list)
    sitemaps: list[str] = field(default_factory=list)
    global_signals: dict[str, str] = field(default_factory=dict)
    licenses: list[str] = field(default_factory=list)  # RSL "License:" URLs
    issues: list[str] = field(default_factory=list)
    # "parsed", "missing" (4xx: allow all), "unreachable" (5xx/network: disallow all)
    state: str = "parsed"

    # -- group selection -------------------------------------------------
    def _groups_for(self, token: str) -> tuple[list[Group], str]:
        wanted = token.strip().lower()
        own = [g for g in self.groups if any(_agent_token(a) == wanted for a in g.agents)]
        if own:
            return own, token
        star = [g for g in self.groups if any(_agent_token(a) == "*" for a in g.agents)]
        if star:
            return star, "*"
        return [], "none"

    def rules_for(self, token: str) -> tuple[list[Rule], str]:
        groups, label = self._groups_for(token)
        rules: list[Rule] = []
        for group in groups:
            rules.extend(group.rules)
        return rules, label

    def signals_for(self, token: str) -> dict[str, str]:
        groups, _ = self._groups_for(token)
        merged = dict(self.global_signals)
        for group in groups:
            merged.update(group.signals)
        return merged

    # -- access decision -------------------------------------------------
    def check(self, token: str, path: str = "/") -> Decision:
        if self.state == "missing":
            return Decision(True, None, "none")
        if self.state == "unreachable":
            return Decision(False, None, "unreachable")
        if path.split("?", 1)[0] == "/robots.txt":
            return Decision(True, None, "robots.txt")
        rules, label = self.rules_for(token)
        best: Rule | None = None
        for rule in rules:
            if not rule.pattern:
                continue  # an empty allow/disallow has no effect
            if rule.regex().match(path):
                if best is None or rule.specificity > best.specificity or (
                    rule.specificity == best.specificity and rule.allow and not best.allow
                ):
                    best = rule
        if best is None:
            return Decision(True, None, label)
        return Decision(best.allow, best, label)


def _agent_token(value: str) -> str:
    # "GPTBot/1.1" -> "gptbot"; tokens are compared case-insensitively.
    return value.strip().split("/", 1)[0].strip().lower()


_SIGNAL_PAIR = re.compile(r"([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([A-Za-z]+)")


def parse_signals(value: str) -> dict[str, str]:
    return {k.lower(): v.lower() for k, v in _SIGNAL_PAIR.findall(value)}


def parse(text: str) -> RobotsTxt:
    robots = RobotsTxt()
    current: Group | None = None
    last_was_agent = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if ":" not in line:
            robots.issues.append(f"line {number}: not a 'field: value' line")
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key in {"user-agent", "useragent", "user agent"}:
            if current is not None and last_was_agent:
                current.agents.append(value)
            else:
                current = Group(agents=[value], line=number)
                robots.groups.append(current)
            last_was_agent = True
            continue
        if key in {"allow", "disallow"}:
            # Only a rule ends the run of user-agent lines that forms a group;
            # sitemap, content-signal and unknown lines do not.
            last_was_agent = False
            if current is None:
                robots.issues.append(f"line {number}: '{key}' appears before any user-agent line and is ignored")
                continue
            current.rules.append(Rule(allow=(key == "allow"), pattern=value, line=number))
        elif key == "sitemap":
            robots.sitemaps.append(value)
        elif key == "license":  # RSL (Really Simple Licensing) points at a license file
            robots.licenses.append(value)
        elif key == "content-signal":
            target = current.signals if current is not None else robots.global_signals
            target.update(parse_signals(value))
        # crawl-delay, host and other extensions are tolerated and ignored
    if not robots.groups:
        robots.issues.append("no user-agent groups found")
    return robots


def from_response(status: int | None, text: str, error: str | None, looks_like_html: bool) -> RobotsTxt:
    """Build a RobotsTxt that follows RFC 9309's rules for fetch outcomes."""

    if error is not None or status is None or status >= 500:
        robots = RobotsTxt(state="unreachable")
        robots.issues.append("robots.txt could not be fetched (server error or network failure); "
                             "RFC 9309 says crawlers should then assume everything is disallowed")
        return robots
    if status >= 400:
        robots = RobotsTxt(state="missing")
        robots.issues.append(f"no robots.txt (HTTP {status}); crawlers may fetch everything")
        return robots
    if looks_like_html:
        robots = RobotsTxt(state="missing")
        robots.issues.append("robots.txt returned an HTML page (often a single-page-app fallback), "
                             "so crawlers see no rules")
        return robots
    return parse(text[:MAX_ROBOTS_BYTES])

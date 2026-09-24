"""Detect WebMCP tools a page exposes to AI agents (W3C WebMCP draft).

Two ways a page can offer tools (per the draft as of 2026-09):

* Declarative: a <form> with ``toolname`` and ``tooldescription`` attributes.
  Each named field becomes a tool parameter; ``toolparamdescription`` describes
  it; ``toolautosubmit`` lets the agent submit without the user checking.
* Imperative: JavaScript calls ``document.modelContext.registerTool({...})``.

Declarative tools are fully visible in HTML. Imperative tools only exist after
scripts run, so this module reports script *evidence* of the API (and any tool
names written as literals) rather than claiming a complete list. The API is only
available in secure contexts, so a page served over plain HTTP cannot offer
WebMCP tools at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .html_scan import PageScan

_API_USE = re.compile(r"\bmodelContext\s*\.\s*(registerTool|provideContext)\s*\(")
_API_REF = re.compile(r"\b(?:document|navigator)\s*\.\s*modelContext\b")
_TOOL_NAME = re.compile(r"registerTool\s*\(\s*\{[^{}]{0,400}?\bname\s*:\s*([\"'`])([^\"'`]{1,120})\1", re.S)


@dataclass
class DeclarativeTool:
    name: str
    description: str
    params: int
    params_described: int
    autosubmit: bool
    issues: list[str] = field(default_factory=list)


@dataclass
class WebMcpReport:
    secure_context: bool
    declarative_tools: list[DeclarativeTool] = field(default_factory=list)
    imperative_api_detected: bool = False
    imperative_tool_names: list[str] = field(default_factory=list)
    scripts_scanned: int = 0
    issues: list[str] = field(default_factory=list)

    @property
    def has_tools(self) -> bool:
        return bool(self.declarative_tools) or self.imperative_api_detected


def _check_form(form) -> DeclarativeTool:
    name = (form.tool_name or "").strip()
    desc = (form.tool_description or "").strip()
    named = [f for f in form.fields if f.name]
    described = [f for f in named if (f.param_description or "").strip()]
    tool = DeclarativeTool(
        name=name,
        description=desc,
        params=len(named),
        params_described=len(described),
        autosubmit="toolautosubmit" in form.attrs,
    )
    if not name:
        tool.issues.append("missing toolname")
    if not desc:
        tool.issues.append("missing tooldescription; agents need it to know when to use the tool")
    elif len(desc) < 20:
        tool.issues.append("tooldescription is very short; say what the tool does and when to use it")
    unnamed = [f for f in form.fields if not f.name]
    if unnamed:
        tool.issues.append(f"{len(unnamed)} field(s) have no name attribute and cannot become parameters")
    if named and len(described) < len(named):
        tool.issues.append(f"{len(named) - len(described)} of {len(named)} parameter(s) lack toolparamdescription")
    if tool.autosubmit:
        tool.issues.append("toolautosubmit lets agents submit without the user checking; use only for safe, reversible actions")
    return tool


def analyze(page: PageScan, *, final_url: str, external_scripts: list[str] | None = None) -> WebMcpReport:
    report = WebMcpReport(secure_context=final_url.lower().startswith("https://"))
    for form in page.forms:
        if form.is_webmcp_tool:
            report.declarative_tools.append(_check_form(form))

    names: list[str] = []
    sources = list(page.inline_scripts) + list(external_scripts or [])
    report.scripts_scanned = len(sources)
    for source in sources:
        if _API_USE.search(source) or _API_REF.search(source):
            report.imperative_api_detected = True
        for match in _TOOL_NAME.finditer(source):
            if match.group(2) not in names:
                names.append(match.group(2))
    report.imperative_tool_names = names

    if report.has_tools and not report.secure_context:
        report.issues.append("page is served over HTTP; WebMCP only works in secure (HTTPS) contexts")
    return report

"""Machine-readable files that tell agents what a site offers and permits.

Checked paths:
    /.well-known/agent-card.json   A2A agent card (older drafts: /.well-known/agent.json)
    /.well-known/ai-plugin.json    legacy ChatGPT plugin manifest
    /.well-known/tdmrep.json       TDMRep text-and-data-mining reservation (W3C CG)
    /ai.txt                        Spawning ai.txt permissions file
    /llms-full.txt                 full-text companion to llms.txt

Many sites answer every unknown path with their HTML homepage and status 200.
A file only counts as present when it is not that HTML fallback and, for JSON
files, when it parses.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

from .fetch import Fetcher, Response

WELL_KNOWN = {
    "a2aAgentCard": "/.well-known/agent-card.json",
    "a2aAgentCardLegacy": "/.well-known/agent.json",
    "aiPluginManifest": "/.well-known/ai-plugin.json",
    "tdmrep": "/.well-known/tdmrep.json",
    "aiTxt": "/ai.txt",
    "llmsFullTxt": "/llms-full.txt",
}
JSON_FILES = {"a2aAgentCard", "a2aAgentCardLegacy", "aiPluginManifest", "tdmrep"}


@dataclass
class FileCheck:
    present: bool
    url: str
    status: int | None
    note: str = ""
    data: Any = None


@dataclass
class DiscoveryReport:
    files: dict[str, FileCheck] = field(default_factory=dict)
    tdm_reserved: bool | None = None       # True = rights holder reserves TDM (opt-out)
    tdm_policy: str | None = None


def _judge(key: str, resp: Response) -> FileCheck:
    if resp.error or resp.status is None:
        return FileCheck(False, resp.url, None, f"not reachable ({resp.error})")
    if resp.status != 200:
        return FileCheck(False, resp.url, resp.status, f"HTTP {resp.status}")
    if resp.looks_like_html():
        return FileCheck(False, resp.url, resp.status, "returned an HTML page instead of the file (catch-all route)")
    if key in JSON_FILES:
        try:
            data = json.loads(resp.text)
        except ValueError:
            return FileCheck(False, resp.url, resp.status, "not valid JSON")
        return FileCheck(True, resp.url, resp.status, "valid JSON", data)
    if not resp.text.strip():
        return FileCheck(False, resp.url, resp.status, "empty file")
    return FileCheck(True, resp.url, resp.status, "present")


def _tdm_from_file(data: Any) -> tuple[bool | None, str | None]:
    # tdmrep.json is a list of {"location": "/*", "tdm-reservation": 0|1, "tdm-policy": url}
    if not isinstance(data, list):
        return None, None
    for entry in data:
        if isinstance(entry, dict) and str(entry.get("location", "")).strip() in {"/*", "/", "*"}:
            reserved = str(entry.get("tdm-reservation", "")).strip() == "1"
            return reserved, entry.get("tdm-policy")
    for entry in data:
        if isinstance(entry, dict) and "tdm-reservation" in entry:
            return str(entry.get("tdm-reservation")).strip() == "1", entry.get("tdm-policy")
    return None, None


async def check(fetcher: Fetcher, origin: str, *, homepage: Response | None = None,
                meta: dict[str, str] | None = None) -> DiscoveryReport:
    report = DiscoveryReport()
    keys = list(WELL_KNOWN)
    responses = await asyncio.gather(*(fetcher.get(urljoin(origin, WELL_KNOWN[k]), max_bytes=500_000) for k in keys))
    for key, resp in zip(keys, responses):
        report.files[key] = _judge(key, resp)

    tdm_file = report.files["tdmrep"]
    if tdm_file.present:
        report.tdm_reserved, report.tdm_policy = _tdm_from_file(tdm_file.data)
    # The HTTP header and meta tag on the homepage also carry TDMRep.
    if report.tdm_reserved is None and homepage is not None:
        header = homepage.headers.get("tdm-reservation")
        if header is not None:
            report.tdm_reserved = header.strip() == "1"
            report.tdm_policy = homepage.headers.get("tdm-policy")
    if report.tdm_reserved is None and meta:
        if "tdm-reservation" in meta:
            report.tdm_reserved = meta["tdm-reservation"].strip() == "1"
            report.tdm_policy = meta.get("tdm-policy")
    return report

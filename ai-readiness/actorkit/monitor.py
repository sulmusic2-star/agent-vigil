"""Change detection between scheduled runs.

Each actor can keep a small snapshot per site in a named key-value store that
lives in the user's account. On the next run it reports what changed, for
example "GPTBot: allowed -> blocked" or "score: 62 -> 71". This is what makes a
scheduled weekly check useful rather than a repeat of the same report.
"""

from __future__ import annotations

import re
from typing import Any

_KEY_SAFE = re.compile(r"[^a-zA-Z0-9!\-_.'()]")


def store_key(url: str) -> str:
    key = _KEY_SAFE.sub("_", url.replace("https://", "").replace("http://", "").rstrip("/"))
    return key[:250] or "site"


def snapshot(kind: str, item: dict[str, Any]) -> dict[str, Any]:
    if kind == "crawler-access":
        return {
            "policy": item.get("policy"),
            "contentSignals": item.get("contentSignals") or {},
            "tdmReservation": item.get("tdmReservation"),
            "agents": {row["agent"]: row["status"] for row in item.get("agents") or []},
        }
    if kind == "llms-check":
        return {k: item.get(k) for k in ("present", "valid", "linkCount", "errors")}
    if kind == "readiness":
        webmcp = item.get("webmcp") or {}
        return {
            "score": item.get("score"),
            "grade": item.get("grade"),
            "policy": (item.get("aiAccess") or {}).get("policy"),
            "llmsTxtValid": (item.get("llmsTxt") or {}).get("valid"),
            "webmcpTools": len(webmcp.get("declarativeTools") or []) + len(webmcp.get("imperativeToolNames") or []),
        }
    if kind == "product":
        return {"score": item.get("score"), "missing": sorted(item.get("missing") or [])}
    return {}


def diff(before: dict[str, Any] | None, after: dict[str, Any]) -> list[dict[str, Any]]:
    if not before:
        return []
    changes: list[dict[str, Any]] = []
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if isinstance(old, dict) and isinstance(new, dict):
            for sub in sorted(set(old) | set(new)):
                if old.get(sub) != new.get(sub):
                    changes.append({"field": f"{key}.{sub}", "before": old.get(sub), "after": new.get(sub)})
        elif old != new:
            changes.append({"field": key, "before": old, "after": new})
    return changes

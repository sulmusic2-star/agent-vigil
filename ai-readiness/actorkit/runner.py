"""Actor runtime: parse input, audit many sites concurrently, save results.

Billing is per saved result, through Apify's built-in ``apify-default-dataset-item``
pay-per-event event, so there is no custom charging code. To keep that fair:

* sites that could not be reached at all, invalid entries, and timeouts are NOT
  saved to the dataset, so the user is not charged for them; they are listed in
  the run's OUTPUT record instead;
* when the user's spending limit is reached, no new sites are started.

``process`` holds all the logic and has no Apify dependency, so it is tested
directly. ``run_actor`` is the thin Apify wrapper each actor's main.py calls.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from readiness import audit
from readiness.fetch import normalize_page, normalize_site

from . import monitor

KINDS = {
    # kind: (engine function, input key, per-item timeout seconds, monitorable)
    "crawler-access": (audit.audit_crawler_access, "websites", 45, True),
    "llms-check": (audit.audit_llms_txt, "websites", 30, True),
    "llms-generate": (audit.generate_llms_txt, "websites", 180, False),
    "readiness": (audit.audit_readiness, "websites", 90, True),
    "product": (audit.audit_product_page, "productUrls", 45, True),
}


@dataclass
class RunSummary:
    requested: int = 0
    saved: int = 0
    failed: list[dict[str, str]] = field(default_factory=list)
    not_started: int = 0
    stopped_by_spending_limit: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "requested": self.requested,
            "saved": self.saved,
            "couldNotCheck": self.failed,
            "notStartedDueToSpendingLimit": self.not_started,
            "stoppedBySpendingLimit": self.stopped_by_spending_limit,
        }


def collect_inputs(kind: str, raw: dict[str, Any]) -> tuple[list[str], list[dict[str, str]]]:
    """Return (unique normalized targets, invalid entries) from the actor input."""

    key = KINDS[kind][1]
    values: list[str] = []
    for entry in raw.get(key) or []:
        if isinstance(entry, str):
            values.append(entry)
    for entry in raw.get("startUrls") or []:  # accept Apify's common startUrls shape too
        if isinstance(entry, dict) and isinstance(entry.get("url"), str):
            values.append(entry["url"])
        elif isinstance(entry, str):
            values.append(entry)
    normalize = normalize_page if kind == "product" else normalize_site
    targets: list[str] = []
    invalid: list[dict[str, str]] = []
    for value in values:
        norm = normalize(value)
        if norm is None:
            if value.strip():
                invalid.append({"input": value, "reason": "not a valid http(s) URL or domain"})
            continue
        if norm not in targets:
            targets.append(norm)
    return targets, invalid


async def process(
    targets: list[str],
    audit_fn: Callable[[str], Awaitable[dict[str, Any]]],
    push_fn: Callable[[dict[str, Any]], Awaitable[bool]],
    *,
    concurrency: int = 10,
    timeout: float = 60,
    on_result: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
) -> RunSummary:
    """Audit targets with bounded concurrency. push_fn returns True when the spending limit is hit."""

    summary = RunSummary(requested=len(targets))
    queue: asyncio.Queue[str] = asyncio.Queue()
    for target in targets:
        queue.put_nowait(target)
    stop = asyncio.Event()
    push_lock = asyncio.Lock()

    async def worker() -> None:
        while not stop.is_set():
            try:
                target = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                result = await asyncio.wait_for(audit_fn(target), timeout)
            except asyncio.TimeoutError:
                summary.failed.append({"input": target, "reason": f"timed out after {int(timeout)}s"})
                continue
            except Exception as exc:  # one bad site must never end the run
                summary.failed.append({"input": target, "reason": f"{type(exc).__name__}: {exc}"})
                continue
            # No useful data -> not saved, so not charged.
            if result.get("error"):
                summary.failed.append({"input": target, "reason": str(result.get("error"))})
                continue
            if result.get("skipped"):
                summary.failed.append({"input": target, "reason": str(result.get("skipped"))})
                continue
            if result.get("reachable") is False:
                summary.failed.append({"input": target, "reason": "the site did not respond"})
                continue
            if on_result is not None:
                result = await on_result(result)
            async with push_lock:
                if stop.is_set():
                    queue.put_nowait(target)  # counted as not started below
                    return
                limit_hit = await push_fn(result)
                summary.saved += 1
                if limit_hit:
                    summary.stopped_by_spending_limit = True
                    stop.set()

    workers = max(1, min(concurrency, len(targets)))
    await asyncio.gather(*(worker() for _ in range(workers)))
    summary.not_started = queue.qsize()
    return summary


def _options(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    respect = bool(raw.get("respectRobotsTxt", True))
    extra = [str(x) for x in (raw.get("extraAiAgents") or []) if str(x).strip()]
    if kind == "crawler-access":
        return {"extra_agents": extra, "check_page": bool(raw.get("checkPageDirectives", True)),
                "respect_robots": respect}
    if kind == "llms-generate":
        pages = int(raw.get("maxPages", 40) or 40)
        return {"max_pages": max(1, min(pages, 200)), "respect_robots": respect}
    if kind == "readiness":
        return {"extra_agents": extra, "respect_robots": respect, "scan_scripts": bool(raw.get("scanScripts", True))}
    if kind == "product":
        return {"respect_robots": respect}
    return {}


async def run_actor(kind: str) -> None:
    from apify import Actor

    from readiness.fetch import HttpxFetcher

    engine, _, timeout, monitorable = KINDS[kind]
    async with Actor:
        raw = await Actor.get_input() or {}
        targets, invalid = collect_inputs(kind, raw)
        if not targets:
            await Actor.fail(status_message="No valid websites in the input. Add domains like example.com.")
            return
        concurrency = max(1, min(int(raw.get("maxConcurrency", 10) or 10), 50))
        options = _options(kind, raw)
        monitor_store = None
        if monitorable and raw.get("monitorChanges"):
            monitor_store = await Actor.open_key_value_store(name=f"ai-readiness-monitor-{kind}")

        fetcher = HttpxFetcher(max_concurrency=concurrency * 4)

        async def audit_fn(target: str) -> dict[str, Any]:
            return await engine(fetcher, target, **options)

        async def on_result(item: dict[str, Any]) -> dict[str, Any]:
            if kind == "llms-generate" and item.get("llmsTxt"):
                key = "llms-" + monitor.store_key(item.get("domain") or item["url"]) + ".txt"
                await Actor.set_value(key, item["llmsTxt"], content_type="text/plain; charset=utf-8")
                item["llmsTxtFileKey"] = key
            if monitor_store is not None:
                key = monitor.store_key(item["url"])
                snap = monitor.snapshot(kind, item)
                previous = await monitor_store.get_value(key)
                item["firstCheck"] = previous is None
                item["changes"] = monitor.diff(previous, snap)
                await monitor_store.set_value(key, snap)
            return item

        async def push_fn(item: dict[str, Any]) -> bool:
            result = await Actor.push_data(item)
            return bool(getattr(result, "event_charge_limit_reached", False))

        await Actor.set_status_message(f"Checking {len(targets)} site(s)")
        try:
            summary = await process(targets, audit_fn, push_fn, concurrency=concurrency,
                                    timeout=timeout, on_result=on_result)
        finally:
            await fetcher.aclose()
        summary.failed = invalid + summary.failed
        summary.requested += len(invalid)
        await Actor.set_value("OUTPUT", summary.as_dict())
        message = f"Done: {summary.saved} saved"
        if summary.failed:
            message += f", {len(summary.failed)} could not be checked (not charged)"
        if summary.stopped_by_spending_limit:
            message += f"; stopped at your spending limit with {summary.not_started} not started"
        await Actor.set_status_message(message, is_terminal=True)

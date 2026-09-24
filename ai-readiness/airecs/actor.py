"""Apify wrapper for the AI Product Recommendation Tracker.

Pay per event:
    chatgpt-answer, perplexity-answer, gemini-answer, claude-answer
        one AI answer used in a saved result, new or reused from earlier that week
    apify-default-dataset-item
        one saved question (Apify's built-in event)
Questions that no engine could answer are not saved, so they are not charged. The
run stops starting new questions when the user's spending limit is reached.

API keys come from the Actor's secret environment variables (OPENAI_API_KEY,
PERPLEXITY_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY). An engine without a key is
skipped and listed in the run's OUTPUT record.

Answers are cached per ISO week. With AIRECS_CACHE_TOKEN set (a token for the
Actor owner's account), every user's runs share one cache in the owner's account.
Without it, each user's runs share a cache in their own account.
"""

from __future__ import annotations

import os
from typing import Any

from actorkit.runner import process

from .engines import API_KEY_ENV, DEFAULT_MODELS, LABELS, Location, build_engines, fake_engines_from_file
from .track import AnswerCache, TrackOptions, track_question

MAX_QUESTIONS = 1000
MAX_QUESTION_CHARS = 300
DEFAULT_ENGINES = ["chatgpt", "perplexity", "gemini"]
QUESTION_TIMEOUT = 300
CACHE_STORE = "ai-recs-answer-cache"


def collect_questions(raw: dict[str, Any]) -> tuple[list[str], list[dict[str, str]]]:
    questions: list[str] = []
    skipped: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw.get("questions") or []:
        if not isinstance(entry, str):
            continue
        text = " ".join(entry.split())
        if not text:
            continue
        if len(text) > MAX_QUESTION_CHARS:
            skipped.append({"input": text[:80] + "…", "reason": f"longer than {MAX_QUESTION_CHARS} characters"})
            continue
        key = text.lower()
        if key not in seen:
            seen.add(key)
            questions.append(text)
    if len(questions) > MAX_QUESTIONS:
        skipped += [{"input": q, "reason": f"more than {MAX_QUESTIONS} questions in one run"}
                    for q in questions[MAX_QUESTIONS:]]
        questions = questions[:MAX_QUESTIONS]
    return questions, skipped


def selected_engines(raw: dict[str, Any]) -> list[str]:
    chosen = [e for e in (raw.get("engines") or DEFAULT_ENGINES) if e in LABELS]
    return list(dict.fromkeys(chosen)) or list(DEFAULT_ENGINES)


def track_options(raw: dict[str, Any]) -> TrackOptions:
    country = str(raw.get("country") or "").strip().upper() or None
    city = str(raw.get("city") or "").strip() or None
    brands = [" ".join(str(b).split()) for b in raw.get("brands") or [] if str(b).strip()]
    return TrackOptions(
        samples=max(1, min(int(raw.get("samplesPerEngine", 2) or 2), 5)),
        brands=list(dict.fromkeys(brands))[:50],
        location=Location(country=country, city=city) if (country or city) else None,
        reuse_recent=bool(raw.get("reuseRecentAnswers", True)),
        include_answers=bool(raw.get("includeAnswerText", True)),
    )


def model_overrides(raw: dict[str, Any]) -> dict[str, str]:
    return {name: str(raw.get(f"{name}Model") or "").strip() for name in LABELS if raw.get(f"{name}Model")}


class SdkCache:
    """A key-value store opened through the Apify SDK (the user's own account)."""

    def __init__(self, store: Any) -> None:
        self.store = store

    async def get(self, key: str) -> dict[str, Any] | None:
        value = await self.store.get_value(key)
        return value if isinstance(value, dict) else None

    async def put(self, key: str, record: dict[str, Any]) -> None:
        await self.store.set_value(key, record)


class ClientCache:
    """A key-value store in the Actor owner's account, shared by every user's runs."""

    def __init__(self, store_client: Any) -> None:
        self.store = store_client

    async def get(self, key: str) -> dict[str, Any] | None:
        record = await self.store.get_record(key)
        value = record.get("value") if record else None
        return value if isinstance(value, dict) else None

    async def put(self, key: str, record: dict[str, Any]) -> None:
        await self.store.set_record(key, record, content_type="application/json; charset=utf-8")


async def open_cache(actor: Any) -> tuple[AnswerCache, str]:
    token = os.environ.get("AIRECS_CACHE_TOKEN", "").strip()
    name = os.environ.get("AIRECS_CACHE_STORE", CACHE_STORE).strip() or CACHE_STORE
    if token:
        try:
            from apify_client import ApifyClientAsync

            client = ApifyClientAsync(token=token)
            store = await client.key_value_stores().get_or_create(name=name)
            return ClientCache(client.key_value_store(store.id)), "shared"
        except Exception as exc:  # fall back to the user's own cache
            actor.log.warning(f"Shared answer cache unavailable ({type(exc).__name__}); using this account's cache")
    return SdkCache(await actor.open_key_value_store(name=name)), "account"


async def run() -> None:
    from apify import Actor

    async with Actor:
        raw = await Actor.get_input() or {}
        questions, skipped = collect_questions(raw)
        if not questions:
            await Actor.fail(status_message="No questions in the input. Add questions like 'best running shoes for flat feet'.")
            return
        chosen = selected_engines(raw)
        fake_file = os.environ.get("AIRECS_FAKE_ANSWERS")  # local testing only
        http_client = None
        if fake_file:
            engines, missing = fake_engines_from_file(fake_file, chosen), []
        else:
            import httpx

            http_client = httpx.AsyncClient(timeout=httpx.Timeout(150.0),
                                            headers={"User-Agent": "ai-product-recommendation-tracker/0.1"})
            keys = {name: os.environ.get(API_KEY_ENV[name]) for name in chosen}
            engines, missing = build_engines(chosen, keys, model_overrides(raw), http_client)
        if not engines:
            names = ", ".join(LABELS[n] for n in chosen)
            await Actor.fail(status_message=f"None of the selected AI engines ({names}) is set up on this Actor yet.")
            return
        if missing:
            Actor.log.warning("Not set up, skipped: " + ", ".join(LABELS[n] for n in missing))
        opts = track_options(raw)
        cache, cache_kind = await open_cache(Actor)
        charged: dict[str, int] = {e.name: 0 for e in engines}

        async def audit_fn(question: str) -> dict[str, Any]:
            return await track_question(question, engines, opts, cache)

        async def push_fn(item: dict[str, Any]) -> bool:
            result = await Actor.push_data(item)
            limit_hit = bool(getattr(result, "event_charge_limit_reached", False))
            for row in item.get("engines", []):
                if row["answers"]:
                    charge = await Actor.charge(event_name=f"{row['engine']}-answer", count=row["answers"])
                    charged[row["engine"]] += getattr(charge, "charged_count", row["answers"])
                    limit_hit = limit_hit or bool(getattr(charge, "event_charge_limit_reached", False))
            return limit_hit

        concurrency = max(1, min(int(raw.get("maxConcurrency", 3) or 3), 20))
        await Actor.set_status_message(
            f"Asking {', '.join(LABELS[e.name] for e in engines)} {len(questions)} question(s), "
            f"{opts.samples} time(s) each")
        try:
            summary = await process(questions, audit_fn, push_fn, concurrency=concurrency, timeout=QUESTION_TIMEOUT)
        finally:
            if http_client is not None:
                await http_client.aclose()
        summary.failed = skipped + summary.failed
        summary.requested += len(skipped)
        output = summary.as_dict()
        output.update({
            "engines": [{"engine": e.name, "label": LABELS[e.name], "model": e.model} for e in engines],
            "enginesNotSetUp": [LABELS[n] for n in missing],
            "answersCharged": charged,
            "answerCache": cache_kind,
            "defaultModels": DEFAULT_MODELS,
        })
        await Actor.set_value("OUTPUT", output)
        message = f"Done: {summary.saved} question(s) saved"
        if summary.failed:
            message += f", {len(summary.failed)} not answered (not charged)"
        if summary.stopped_by_spending_limit:
            message += f"; stopped at your spending limit with {summary.not_started} not started"
        await Actor.set_status_message(message, is_terminal=True)

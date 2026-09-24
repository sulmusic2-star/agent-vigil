"""Ask every engine a question several times and measure what they recommend.

AI answers vary from one ask to the next, so each engine is asked ``samples``
times and a recommendation is scored by how many of the answers list it.

Answers are cached by engine, model, question, location, sample number and ISO
week. A second buyer who asks the same question in the same week is served the
same answers, so the AI questions are paid for once however many people read them.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from .engines import LABELS, Answer, Engine, Location
from .extract import brand_hits, domain_of, extract_items, normalize

MAX_ANSWER_CHARS = 4000
TOP_RECOMMENDATIONS = 15
TOP_SOURCES = 15


class AnswerCache(Protocol):
    async def get(self, key: str) -> dict[str, Any] | None: ...

    async def put(self, key: str, record: dict[str, Any]) -> None: ...


class MemoryCache:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}

    async def get(self, key: str) -> dict[str, Any] | None:
        return self.records.get(key)

    async def put(self, key: str, record: dict[str, Any]) -> None:
        self.records[key] = record


@dataclass
class TrackOptions:
    samples: int = 2
    brands: list[str] = field(default_factory=list)
    location: Location | None = None
    reuse_recent: bool = True
    include_answers: bool = True
    per_engine_parallel: int = 2


def iso_week(now: datetime) -> str:
    year, week, _ = now.isocalendar()
    return f"{year}-W{week:02d}"


def cache_key(engine: str, model: str, question: str, location: Location | None, sample: int, week: str) -> str:
    """Apify key-value store keys allow letters, digits and a few symbols, up to 256 characters."""

    raw = "|".join((engine, model, " ".join(question.lower().split()), location.key() if location else "",
                    str(sample), week))
    return "answer-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


async def _ask(engine: Engine, question: str, sample: int, opts: TrackOptions, cache: AnswerCache | None,
               week: str, slots: asyncio.Semaphore) -> Answer:
    key = cache_key(engine.name, engine.model, question, opts.location, sample, week)
    if cache is not None and opts.reuse_recent:
        try:
            record = await cache.get(key)
        except Exception:  # a cache outage must not stop the measurement
            record = None
        if record:
            return Answer.from_record(record, reused=True)
    async with slots:
        answer = await engine.ask(question, opts.location)
    if cache is not None and answer.ok:
        try:
            await cache.put(key, answer.to_record())
        except Exception:
            pass
    return answer


async def ask_all(question: str, engines: list[Engine], opts: TrackOptions, cache: AnswerCache | None = None,
                  now: datetime | None = None) -> list[tuple[int, Answer]]:
    """Every (sample number, answer) for every engine; engines run in parallel."""

    week = iso_week(now or datetime.now(timezone.utc))
    jobs = []
    for engine in engines:
        slots = asyncio.Semaphore(max(1, opts.per_engine_parallel))
        for sample in range(1, max(1, opts.samples) + 1):
            jobs.append((sample, _ask(engine, question, sample, opts, cache, week, slots)))
    answers = await asyncio.gather(*(job for _, job in jobs))
    return [(sample, answer) for (sample, _), answer in zip(jobs, answers)]


def _merge_keys(keys: list[str]) -> dict[str, str]:
    """Map longer names onto a shorter one that starts them: 'brooks ghost 16 running shoe' -> 'brooks ghost 16'.

    Only names of two or more words absorb others, so a brand alone never swallows its models.
    """

    target = {k: k for k in keys}
    for short in sorted(set(keys), key=len):
        if len(short.split()) < 2:
            continue
        for other in keys:
            if other != short and target[other] == other and other.startswith(short + " "):
                target[other] = short
    return target


def aggregate(question: str, answers: list[tuple[int, Answer]], engines: list[Engine], opts: TrackOptions,
              checked_at: str) -> dict[str, Any]:
    ok = [(s, a) for s, a in answers if a.ok]
    total = len(ok)
    if not total:
        first = next((a.error for _, a in answers if a.error), "no answer")
        return {"question": question, "error": f"no AI engine answered: {first}"}

    per_answer_items = [(s, a, extract_items(a.text)) for s, a in ok]
    all_keys = [normalize(item.name) for _, _, items in per_answer_items for item in items]
    merged = _merge_keys(all_keys)
    names: dict[str, Counter] = defaultdict(Counter)
    stats: dict[str, dict[str, Any]] = {}
    for _, answer, items in per_answer_items:
        seen_here: set[str] = set()
        for item in items:
            key = merged.get(normalize(item.name), normalize(item.name))
            names[key][item.name] += 1
            if key in seen_here:
                continue
            seen_here.add(key)
            row = stats.setdefault(key, {"answers": 0, "ranks": [], "engines": set()})
            row["answers"] += 1
            row["ranks"].append(item.rank)
            row["engines"].add(answer.engine)

    def rec_rows(keys_stats: dict[str, dict[str, Any]], denominator: int, limit: int) -> list[dict[str, Any]]:
        rows = []
        for key, row in keys_stats.items():
            rows.append({
                "name": names[key].most_common(1)[0][0],
                "answers": row["answers"],
                "share": round(row["answers"] / denominator, 3),
                "engines": [LABELS[e] for e in LABELS if e in row["engines"]],
                "bestRank": min(row["ranks"]),
                "averageRank": round(sum(row["ranks"]) / len(row["ranks"]), 2),
            })
        rows.sort(key=lambda r: (-r["answers"], r["averageRank"], r["name"].lower()))
        return rows[:limit]

    engine_rows = []
    for engine in engines:
        mine = [(s, a) for s, a in answers if a.engine == engine.name]
        good = [(s, a, items) for s, a, items in per_answer_items if a.engine == engine.name]
        engine_stats: dict[str, dict[str, Any]] = {}
        for _, answer, items in good:
            seen_here = set()
            for item in items:
                key = merged.get(normalize(item.name), normalize(item.name))
                if key in seen_here:
                    continue
                seen_here.add(key)
                row = engine_stats.setdefault(key, {"answers": 0, "ranks": [], "engines": {engine.name}})
                row["answers"] += 1
                row["ranks"].append(item.rank)
        domains = Counter(src["domain"] or domain_of(src["url"]) or "" for _, a, _ in good for src in a.sources)
        domains.pop("", None)
        errors = sorted({a.error for _, a in mine if a.error})
        engine_rows.append({
            "engine": engine.name,
            "label": LABELS[engine.name],
            "model": engine.model,
            "answers": len(good),
            "reused": sum(1 for _, a, _ in good if a.reused),
            "failed": len(mine) - len(good),
            "errors": errors[:3],
            "recommendations": rec_rows(engine_stats, len(good), 10) if good else [],
            "topSources": [{"domain": d, "citations": n} for d, n in domains.most_common(10)],
        })

    brands = []
    for brand in opts.brands:
        mentioned_in = listed_in = 0
        best_rank = None
        by_engine: dict[str, list[int]] = {}
        for _, answer, items in per_answer_items:
            hit = brand_hits(answer.text, items, [brand])[brand]
            tally = by_engine.setdefault(LABELS[answer.engine], [0, 0])
            tally[1] += 1
            if hit["mentioned"]:
                mentioned_in += 1
                tally[0] += 1
            if hit["rank"] is not None:
                listed_in += 1
                best_rank = hit["rank"] if best_rank is None else min(best_rank, hit["rank"])
        brands.append({
            "brand": brand,
            "mentionedIn": mentioned_in,
            "share": round(mentioned_in / total, 3),
            "listedIn": listed_in,
            "bestRank": best_rank,
            "byEngine": {label: f"{m}/{n}" for label, (m, n) in by_engine.items()},
        })

    source_counts: Counter = Counter()
    source_engines: dict[str, set[str]] = defaultdict(set)
    for _, answer, _ in per_answer_items:
        for src in answer.sources:
            domain = src["domain"] or domain_of(src["url"]) or ""
            if domain:
                source_counts[domain] += 1
                source_engines[domain].add(LABELS[answer.engine])
    top_sources = [{"domain": d, "citations": n, "engines": sorted(source_engines[d])}
                   for d, n in source_counts.most_common(TOP_SOURCES)]

    top = rec_rows(stats, total, TOP_RECOMMENDATIONS)
    result: dict[str, Any] = {
        "question": question,
        "location": opts.location.fields() if opts.location else None,
        "checkedAt": checked_at,
        "answers": {"total": total, "new": sum(1 for _, a in ok if not a.reused),
                    "reused": sum(1 for _, a in ok if a.reused), "failed": len(answers) - total},
        "summary": _summary(top, brands, engine_rows, total),
        "topRecommendation": top[0]["name"] if top else None,
        "topRecommendations": top,
        "brands": brands,
        "engines": engine_rows,
        "topSources": top_sources,
    }
    if opts.include_answers:
        result["answerTexts"] = [
            {"engine": LABELS[a.engine], "sample": s, "reused": a.reused,
             "text": a.text[:MAX_ANSWER_CHARS] + ("…" if len(a.text) > MAX_ANSWER_CHARS else ""),
             "sources": [src["url"] or src["title"] for src in a.sources[:10]]}
            for s, a in ok
        ]
    return result


def _summary(top: list[dict[str, Any]], brands: list[dict[str, Any]], engine_rows: list[dict[str, Any]],
             total: int) -> str:
    answered = [row["label"] for row in engine_rows if row["answers"]]
    names = answered[0] if len(answered) == 1 else ", ".join(answered[:-1]) + " and " + answered[-1]
    parts = [f"{total} answer{'s' if total != 1 else ''} from {names}."]
    if top:
        lead = top[0]
        parts.append(f"Most recommended: {lead['name']} ({lead['answers']} of {total}).")
    else:
        parts.append("No product list found in the answers.")
    for b in brands[:5]:
        where = f", best position {b['bestRank']}" if b["bestRank"] else ""
        parts.append(f"{b['brand']}: in {b['mentionedIn']} of {total}{where}.")
    return " ".join(parts)


async def track_question(question: str, engines: list[Engine], opts: TrackOptions,
                         cache: AnswerCache | None = None, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    answers = await ask_all(question, engines, opts, cache, now)
    return aggregate(question, answers, engines, opts, now.replace(microsecond=0).isoformat())

"""Ask AI assistants a question with live web search, the way they answer shoppers.

Each engine returns an ``Answer``: the text, the sources it cites, and an error
message instead of an exception, so one failing engine never stops a run.
ChatGPT, Perplexity and Gemini are called over HTTP with httpx; Claude through
the official ``anthropic`` SDK.

The APIs approximate the consumer apps. They use the same model families with
live web search, but none of the apps' memory, personalization or shopping widgets.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .extract import domain_of

LABELS = {"chatgpt": "ChatGPT", "perplexity": "Perplexity", "gemini": "Gemini", "claude": "Claude"}
DEFAULT_MODELS = {"chatgpt": "gpt-5-mini", "perplexity": "sonar", "gemini": "gemini-2.5-flash",
                  "claude": "claude-opus-5"}
API_KEY_ENV = {"chatgpt": "OPENAI_API_KEY", "perplexity": "PERPLEXITY_API_KEY", "gemini": "GEMINI_API_KEY",
               "claude": "ANTHROPIC_API_KEY"}
MAX_SOURCES = 30
REQUEST_TIMEOUT = 150.0
CLAUDE_MAX_CONTINUATIONS = 5
# Claude: on a policy decline, let the API retry on Anthropic's recommended fallback model.
CLAUDE_FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass(frozen=True)
class Location:
    """Where the question is asked from. Country is an ISO 3166-1 alpha-2 code such as "US"."""

    country: str | None = None
    city: str | None = None
    region: str | None = None

    def fields(self) -> dict[str, str]:
        return {k: v for k, v in (("country", self.country), ("city", self.city), ("region", self.region)) if v}

    def key(self) -> str:
        return f"{(self.country or '').upper()},{(self.region or '').lower()},{(self.city or '').lower()}"


@dataclass
class Answer:
    engine: str
    model: str
    text: str = ""
    sources: list[dict[str, str]] = field(default_factory=list)  # {"url", "title", "domain"}
    error: str | None = None
    reused: bool = False

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.text.strip())

    def to_record(self) -> dict[str, Any]:
        return {"engine": self.engine, "model": self.model, "text": self.text, "sources": self.sources}

    @classmethod
    def from_record(cls, record: dict[str, Any], reused: bool = True) -> "Answer":
        return cls(engine=record["engine"], model=record["model"], text=record.get("text", ""),
                   sources=list(record.get("sources") or []), reused=reused)


class Engine(Protocol):
    name: str
    model: str

    async def ask(self, question: str, location: Location | None = None) -> Answer: ...


def _source(url: str | None, title: str | None) -> dict[str, str] | None:
    url, title = (url or "").strip(), (title or "").strip()
    if not url and not title:
        return None
    domain = domain_of(url) if url else None
    if url and (not domain or domain.endswith("vertexaisearch.cloud.google.com")):
        domain = domain_of(title) or domain  # Gemini links through a redirect; its title is the site
    return {"url": url, "title": title, "domain": domain or ""}


def _dedupe_sources(sources: list[dict[str, str] | None]) -> list[dict[str, str]]:
    seen, out = set(), []
    for s in sources:
        if s and (s["url"] or s["title"]) not in seen:
            seen.add(s["url"] or s["title"])
            out.append(s)
    return out[:MAX_SOURCES]


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Read a field from an SDK object or a plain dict."""

    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# --- response parsing (pure functions, tested with recorded shapes) -----------

def parse_openai(data: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """OpenAI Responses API: message items carry output_text parts with url_citation annotations."""

    texts, sources = [], []
    for item in data.get("output") or []:
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if part.get("type") in ("output_text", "text"):
                texts.append(part.get("text") or "")
                for ann in part.get("annotations") or []:
                    if ann.get("type") == "url_citation":
                        sources.append(_source(ann.get("url"), ann.get("title")))
    if not texts and isinstance(data.get("output_text"), str):
        texts.append(data["output_text"])
    return "\n\n".join(t for t in texts if t), _dedupe_sources(sources)


def parse_perplexity(data: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """Perplexity chat completions: the answer, plus search_results (or the older citations list)."""

    choices = data.get("choices") or [{}]
    text = ((choices[0] or {}).get("message") or {}).get("content") or ""
    results = data.get("search_results") or []
    sources = [_source(r.get("url"), r.get("title")) for r in results if isinstance(r, dict)]
    if not sources:
        sources = [_source(url, None) for url in data.get("citations") or [] if isinstance(url, str)]
    return text, _dedupe_sources(sources)


def parse_gemini(data: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """Gemini generateContent with Google Search grounding."""

    candidates = data.get("candidates") or [{}]
    first = candidates[0] or {}
    parts = (first.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    chunks = (first.get("groundingMetadata") or {}).get("groundingChunks") or []
    sources = [_source((c.get("web") or {}).get("uri"), (c.get("web") or {}).get("title")) for c in chunks]
    return text, _dedupe_sources(sources)


def parse_claude(content: list[Any]) -> tuple[str, list[dict[str, str]]]:
    """Claude content blocks: text blocks with web-search citations, and web_search_tool_result blocks."""

    texts, sources = [], []
    for block in content or []:
        kind = _get(block, "type")
        if kind == "text":
            texts.append(_get(block, "text", "") or "")
            for cite in _get(block, "citations") or []:
                if _get(cite, "type") == "web_search_result_location":
                    sources.append(_source(_get(cite, "url"), _get(cite, "title")))
        elif kind == "web_search_tool_result":
            results = _get(block, "content")
            if isinstance(results, list):  # otherwise an error object
                for r in results:
                    if _get(r, "type") == "web_search_result":
                        sources.append(_source(_get(r, "url"), _get(r, "title")))
    return "".join(texts).strip(), _dedupe_sources(sources)


def _error_text(status: int, body: str) -> str:
    try:
        err = json.loads(body).get("error")
        message = err.get("message") if isinstance(err, dict) else err
    except (ValueError, AttributeError):
        message = None
    return f"HTTP {status}: {(message or body or 'no details')[:200]}"


# --- engines ----------------------------------------------------------------

class _HttpEngine:
    name = ""
    retry_statuses = {429, 500, 502, 503, 504}

    def __init__(self, api_key: str, model: str, client: Any) -> None:
        self.api_key = api_key
        self.model = model
        self.client = client  # httpx.AsyncClient

    async def _post(self, url: str, body: dict[str, Any], headers: dict[str, str]) -> tuple[dict | None, str | None]:
        for attempt in range(3):
            try:
                resp = await self.client.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
            except Exception as exc:  # network errors become data, never exceptions
                if attempt < 2:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                return None, f"{type(exc).__name__}: could not reach {LABELS[self.name]}"
            if resp.status_code in self.retry_statuses and attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                return None, _error_text(resp.status_code, resp.text)
            try:
                return resp.json(), None
            except ValueError:
                return None, "the response was not JSON"
        return None, "no response"

    def _answer(self, parsed: tuple[str, list[dict[str, str]]] | None, error: str | None) -> Answer:
        if error:
            return Answer(self.name, self.model, error=error)
        text, sources = parsed or ("", [])
        if not text.strip():
            return Answer(self.name, self.model, error="empty answer")
        return Answer(self.name, self.model, text=text, sources=sources)


class OpenAIEngine(_HttpEngine):
    """ChatGPT's models through the OpenAI Responses API with the web_search tool."""

    name = "chatgpt"
    url = "https://api.openai.com/v1/responses"

    async def ask(self, question: str, location: Location | None = None) -> Answer:
        tool: dict[str, Any] = {"type": "web_search"}
        if location and location.fields():
            tool["user_location"] = {"type": "approximate", **location.fields()}
        data, error = await self._post(self.url, {"model": self.model, "input": question, "tools": [tool]},
                                       {"Authorization": f"Bearer {self.api_key}"})
        return self._answer(parse_openai(data) if data else None, error)


class PerplexityEngine(_HttpEngine):
    """Perplexity's Sonar models (search is built in)."""

    name = "perplexity"
    url = "https://api.perplexity.ai/chat/completions"

    async def ask(self, question: str, location: Location | None = None) -> Answer:
        body: dict[str, Any] = {"model": self.model, "messages": [{"role": "user", "content": question}]}
        if location and location.country:
            body["web_search_options"] = {"user_location": {"country": location.country}}
        data, error = await self._post(self.url, body, {"Authorization": f"Bearer {self.api_key}"})
        return self._answer(parse_perplexity(data) if data else None, error)


class GeminiEngine(_HttpEngine):
    """Gemini through the Gemini API with Grounding with Google Search. (It takes no location.)"""

    name = "gemini"
    base = "https://generativelanguage.googleapis.com/v1beta/models"

    async def ask(self, question: str, location: Location | None = None) -> Answer:
        body = {"contents": [{"role": "user", "parts": [{"text": question}]}], "tools": [{"google_search": {}}]}
        data, error = await self._post(f"{self.base}/{self.model}:generateContent", body,
                                       {"x-goog-api-key": self.api_key})
        return self._answer(parse_gemini(data) if data else None, error)


class ClaudeEngine:
    """Claude with the web search server tool, through the official anthropic SDK.

    Handles ``pause_turn`` (a long server-tool turn) by sending the paused turn back
    to continue, up to CLAUDE_MAX_CONTINUATIONS times, and checks for a refusal
    before reading any content. Requests opt into server-side fallbacks
    (``fallbacks="default"``), so a policy decline is retried on Anthropic's
    recommended fallback model.
    """

    name = "claude"

    def __init__(self, api_key: str, model: str, client: Any = None) -> None:
        if client is None:
            from anthropic import AsyncAnthropic  # imported lazily so tests run without the SDK

            client = AsyncAnthropic(api_key=api_key, timeout=REQUEST_TIMEOUT, max_retries=2)
        self.client = client
        self.model = model

    async def ask(self, question: str, location: Location | None = None) -> Answer:
        tool: dict[str, Any] = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}
        if location and location.fields():
            tool["user_location"] = {"type": "approximate", **location.fields()}
        messages: list[dict[str, Any]] = [{"role": "user", "content": question}]
        texts: list[str] = []
        sources: list[dict[str, str] | None] = []
        try:
            for _ in range(CLAUDE_MAX_CONTINUATIONS):
                response = await self.client.beta.messages.create(
                    model=self.model, max_tokens=8000, tools=[tool], messages=messages,
                    betas=[CLAUDE_FALLBACK_BETA], fallbacks="default")
                if response.stop_reason == "refusal":
                    return Answer(self.name, self.model, error="Claude declined to answer")
                text, found = parse_claude(response.content)
                if text and (not texts or text != texts[-1]):
                    texts.append(text)
                sources.extend(found)
                if response.stop_reason != "pause_turn":
                    break
                messages = [{"role": "user", "content": question},
                            {"role": "assistant", "content": response.content}]
        except Exception as exc:  # API and network errors become data
            status = getattr(exc, "status_code", None)
            detail = getattr(exc, "message", None) or type(exc).__name__
            return Answer(self.name, self.model, error=(f"HTTP {status}: " if status else "") + str(detail)[:200])
        text = "\n\n".join(texts).strip()
        if not text:
            return Answer(self.name, self.model, error="empty answer")
        return Answer(self.name, self.model, text=text, sources=_dedupe_sources(sources))


class FakeEngine:
    """Serves canned answers in turn, for tests and local runs. An Exception entry becomes an error."""

    def __init__(self, name: str, answers: list[Any], model: str = "fake") -> None:
        self.name = name
        self.model = model
        self.answers = list(answers)
        self.calls: list[tuple[str, Location | None]] = []

    async def ask(self, question: str, location: Location | None = None) -> Answer:
        entry = self.answers[len(self.calls) % len(self.answers)] if self.answers else ""
        self.calls.append((question, location))
        if isinstance(entry, Exception):
            return Answer(self.name, self.model, error=str(entry))
        if isinstance(entry, dict):
            return Answer(self.name, self.model, text=entry.get("text", ""),
                          sources=_dedupe_sources([_source(s.get("url"), s.get("title"))
                                                   for s in entry.get("sources", [])]))
        return Answer(self.name, self.model, text=str(entry))


def build_engines(selected: list[str], keys: dict[str, str | None], models: dict[str, str] | None = None,
                  http_client: Any = None) -> tuple[list[Engine], list[str]]:
    """Engines for the selected names that have an API key; also returns the names left out."""

    models = {**DEFAULT_MODELS, **{k: v for k, v in (models or {}).items() if v}}
    engines: list[Engine] = []
    missing: list[str] = []
    for name in selected:
        key = (keys.get(name) or "").strip()
        if name not in LABELS:
            continue
        if not key:
            missing.append(name)
            continue
        if name == "claude":
            engines.append(ClaudeEngine(key, models[name]))
        else:
            cls = {"chatgpt": OpenAIEngine, "perplexity": PerplexityEngine, "gemini": GeminiEngine}[name]
            engines.append(cls(key, models[name], http_client))
    return engines, missing


def fake_engines_from_file(path: str | Path, selected: list[str]) -> list[Engine]:
    """Local testing: {"chatgpt": ["answer 1", "answer 2"], ...} served by FakeEngine."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [FakeEngine(name, data[name]) for name in selected if name in data]

"""AI product recommendation tracking: extraction, engine parsing, sampling, caching, aggregation."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from airecs import engines as eng
from airecs.actor import collect_questions, selected_engines, track_options
from airecs.engines import (Answer, ClaudeEngine, FakeEngine, GeminiEngine, Location, OpenAIEngine, PerplexityEngine,
                            build_engines, parse_claude, parse_gemini, parse_openai, parse_perplexity)
from airecs.extract import brand_hits, domain_of, extract_items, normalize
from airecs.track import MemoryCache, TrackOptions, aggregate, cache_key, track_question


def names(text: str) -> list[str]:
    return [item.name for item in extract_items(text)]


# --- extraction ---------------------------------------------------------------

def test_numbered_bold_list_ignores_sub_bullets_and_tips():
    text = """Here are the best running shoes for flat feet:

1. **Brooks Adrenaline GTS 24** – A stability favorite.
   - Price: about $140
   - Best for: overpronators
2. **ASICS Gel-Kayano 31** — Plush cushioning.
3. **Hoka Arahi 7**: lightweight stability.

### Tips
- Replace shoes every 300–500 miles
"""
    assert names(text) == ["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]


def test_labels_before_names_are_dropped():
    text = ("- **Best overall:** Brooks Adrenaline GTS 24 - supportive[1]\n"
            "- **Budget pick:** Saucony Guide 17 [3]\n"
            "- **Max cushion:** Hoka Gaviota 5[2]\n"
            "- **Nike Pegasus 41:** a versatile daily trainer\n")
    assert names(text) == ["Brooks Adrenaline GTS 24", "Saucony Guide 17", "Hoka Gaviota 5", "Nike Pegasus 41"]


def test_headings_as_picks_skip_generic_sections():
    text = "### 1. Brooks Adrenaline GTS 24\nok\n### 2. ASICS GT-2000 13\nok\n### Summary\nChoose by fit."
    assert names(text) == ["Brooks Adrenaline GTS 24", "ASICS GT-2000 13"]


def test_prose_answer_uses_bold_names():
    text = "Try the **Brooks Adrenaline GTS 24** or the **ASICS Gel-Kayano 31**; the **Hoka Arahi 7** is lighter."
    assert names(text) == ["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]


def test_plain_bullets_keep_names_and_drop_sentences():
    text = "Options:\n- Brooks Adrenaline GTS 24\n- ASICS Gel-Kayano 31\n- Replace your shoes regularly\n"
    assert names(text) == ["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31"]


def test_links_citations_and_duplicates():
    text = ("1. **[Roborock Qrevo S](https://example.com/q)** – strong suction [1][2]\n"
            "2. **iRobot Roomba Combo j9+** – self-empties\n"
            "3. **Roborock Qrevo S** – mentioned again\n")
    items = extract_items(text)
    assert [(i.rank, i.name) for i in items] == [(1, "Roborock Qrevo S"), (2, "iRobot Roomba Combo j9+")]


def test_code_blocks_and_tables_are_skipped():
    text = "```\n- not a pick\n- also not\n```\n| a | b |\n|---|---|\n- **Real Pick One** – x\n- **Real Pick Two** – y\n"
    assert names(text) == ["Real Pick One", "Real Pick Two"]


def test_normalize_and_domains():
    assert normalize("The Brooks® Ghost 16!") == "brooks ghost 16"
    assert domain_of("https://www.runnersworld.com/gear/a1") == "runnersworld.com"
    assert domain_of("rtings.com") == "rtings.com"
    assert domain_of("Runner's World") is None


def test_brand_hits_rank_and_mentions():
    text = "1. **Brooks Ghost 16** – soft\n2. **Hoka Clifton 9** – light\n\nNike also makes good shoes."
    hits = brand_hits(text, extract_items(text), ["brooks", "Nike", "Hokaido", "Saucony"])
    assert hits["brooks"] == {"mentioned": True, "rank": 1}
    assert hits["Nike"] == {"mentioned": True, "rank": None}
    assert hits["Hokaido"]["mentioned"] is False and hits["Saucony"]["mentioned"] is False


# --- engine response parsing ------------------------------------------------

def test_parse_openai_responses_output():
    data = {"output": [
        {"type": "web_search_call", "id": "ws_1", "status": "completed"},
        {"type": "message", "content": [{"type": "output_text", "text": "1. **Brooks Ghost 16** – soft",
                                         "annotations": [{"type": "url_citation", "url": "https://www.rtings.com/a",
                                                          "title": "RTINGS"}]}]},
    ]}
    text, sources = parse_openai(data)
    assert text.startswith("1. **Brooks") and sources == [{"url": "https://www.rtings.com/a", "title": "RTINGS",
                                                           "domain": "rtings.com"}]


def test_parse_perplexity_search_results_and_citations():
    data = {"choices": [{"message": {"content": "Answer[1]"}}],
            "search_results": [{"title": "RW", "url": "https://runnersworld.com/x"}]}
    assert parse_perplexity(data) == ("Answer[1]", [{"url": "https://runnersworld.com/x", "title": "RW",
                                                     "domain": "runnersworld.com"}])
    older = {"choices": [{"message": {"content": "A"}}], "citations": ["https://a.com/1", "https://a.com/1"]}
    assert [s["url"] for s in parse_perplexity(older)[1]] == ["https://a.com/1"]


def test_parse_gemini_grounding_uses_title_for_redirect_links():
    data = {"candidates": [{"content": {"parts": [{"text": "Pick "}, {"text": "these."}]},
                            "groundingMetadata": {"groundingChunks": [
                                {"web": {"uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x",
                                         "title": "runnersworld.com"}}]}}]}
    text, sources = parse_gemini(data)
    assert text == "Pick these." and sources[0]["domain"] == "runnersworld.com"


def test_parse_claude_text_citations_and_search_results():
    content = [
        {"type": "server_tool_use", "name": "web_search", "input": {"query": "best shoes"}},
        {"type": "web_search_tool_result", "content": [
            {"type": "web_search_result", "url": "https://www.rtings.com/a", "title": "RTINGS"}]},
        {"type": "web_search_tool_result", "content": {"type": "web_search_tool_result_error",
                                                      "error_code": "max_uses_exceeded"}},
        {"type": "text", "text": "1. **Brooks Ghost 16** – soft", "citations": [
            {"type": "web_search_result_location", "url": "https://runnersworld.com/x", "title": "RW",
             "cited_text": "..."}]},
    ]
    text, sources = parse_claude(content)
    assert text == "1. **Brooks Ghost 16** – soft"
    assert [s["domain"] for s in sources] == ["rtings.com", "runnersworld.com"]  # in content order


# --- engines ------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status: int, payload: dict | None = None, text: str = "") -> None:
        self.status_code = status
        self._payload = payload
        self.text = text or json.dumps(payload or {})

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeHttp:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, dict, dict]] = []

    async def post(self, url, json=None, headers=None, timeout=None):
        self.requests.append((url, json, headers))
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    async def instant(_seconds):
        return None
    monkeypatch.setattr(eng.asyncio, "sleep", instant)


def test_openai_engine_request_and_retry_on_rate_limit():
    ok = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "Hi", "annotations": []}]}]}
    http = FakeHttp([FakeResponse(429, {"error": {"message": "slow down"}}), FakeResponse(200, ok)])
    answer = asyncio.run(OpenAIEngine("sk-test", "gpt-test", http).ask("q?", Location("US", city="Austin")))
    assert answer.ok and answer.text == "Hi" and len(http.requests) == 2
    url, body, headers = http.requests[0]
    assert url.endswith("/v1/responses") and headers["Authorization"] == "Bearer sk-test"
    assert body["tools"] == [{"type": "web_search", "user_location": {"type": "approximate", "country": "US",
                                                                      "city": "Austin"}}]


def test_http_engine_errors_are_data_and_never_include_the_key():
    http = FakeHttp([FakeResponse(401, {"error": {"message": "Incorrect API key provided"}})])
    answer = asyncio.run(PerplexityEngine("pplx-secret", "sonar", http).ask("q?", Location("GB")))
    assert not answer.ok and answer.error == "HTTP 401: Incorrect API key provided"
    assert "pplx-secret" not in answer.error
    assert http.requests[0][1]["web_search_options"] == {"user_location": {"country": "GB"}}


def test_gemini_engine_url_and_empty_answer():
    http = FakeHttp([FakeResponse(200, {"candidates": [{"content": {"parts": []}}]})])
    answer = asyncio.run(GeminiEngine("g-key", "gemini-test", http).ask("q?"))
    assert answer.error == "empty answer"
    url, body, headers = http.requests[0]
    assert url.endswith("/models/gemini-test:generateContent") and headers == {"x-goog-api-key": "g-key"}
    assert body["tools"] == [{"google_search": {}}]


class FakeClaudeMessages:
    def __init__(self, responses) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def fake_claude(responses):
    messages = FakeClaudeMessages(responses)
    return SimpleNamespace(beta=SimpleNamespace(messages=messages)), messages


def test_claude_engine_continues_after_pause_turn_and_opts_into_fallbacks():
    first = SimpleNamespace(stop_reason="pause_turn", content=[
        {"type": "web_search_tool_result", "content": [{"type": "web_search_result", "url": "https://a.com/1",
                                                         "title": "A"}]}])
    second = SimpleNamespace(stop_reason="end_turn", content=[{"type": "text", "text": "- **Pick One** – x"}])
    client, messages = fake_claude([first, second])
    answer = asyncio.run(ClaudeEngine("key", "claude-opus-5", client).ask("best x?", Location("US")))
    assert answer.ok and answer.text == "- **Pick One** – x" and answer.sources[0]["domain"] == "a.com"
    call = messages.calls[0]
    assert call["betas"] == ["server-side-fallback-2026-07-01"] and call["fallbacks"] == "default"
    assert call["tools"][0]["type"] == "web_search_20260209"
    assert call["tools"][0]["user_location"] == {"type": "approximate", "country": "US"}
    assert messages.calls[1]["messages"] == [{"role": "user", "content": "best x?"},
                                             {"role": "assistant", "content": first.content}]


def test_claude_engine_refusal_and_api_error():
    refusal = SimpleNamespace(stop_reason="refusal", content=[])
    client, _ = fake_claude([refusal])
    assert asyncio.run(ClaudeEngine("key", "m", client).ask("q")).error == "Claude declined to answer"
    error = RuntimeError("boom")
    error.status_code = 529
    error.message = "Overloaded"
    client, _ = fake_claude([error])
    assert asyncio.run(ClaudeEngine("key", "m", client).ask("q")).error == "HTTP 529: Overloaded"


def test_build_engines_skips_missing_keys_and_applies_models():
    built, missing = build_engines(["chatgpt", "gemini", "perplexity", "bogus"],
                                   {"chatgpt": "sk", "gemini": " ", "perplexity": "pp"},
                                   {"perplexity": "sonar-pro"}, http_client=object())
    assert [e.name for e in built] == ["chatgpt", "perplexity"] and missing == ["gemini"]
    assert built[0].model == eng.DEFAULT_MODELS["chatgpt"] and built[1].model == "sonar-pro"


# --- tracking -----------------------------------------------------------------

LIST_A = {"text": "1. **Brooks Adrenaline GTS 24** – stable\n2. **ASICS Gel-Kayano 31** – plush",
          "sources": [{"url": "https://www.runnersworld.com/x", "title": "RW"}]}
LIST_B = {"text": "- **Best overall:** Brooks Adrenaline GTS 24 - great\n- **Budget pick:** Saucony Guide 17",
          "sources": [{"url": "https://www.rtings.com/y", "title": "RTINGS"}]}
LIST_G = {"text": "### 1. Brooks Adrenaline GTS 24 Running Shoe\nok\n### 2. New Balance 860v14\nok",
          "sources": [{"url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
                       "title": "runnersworld.com"}]}
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def engines_under_test():
    return [FakeEngine("chatgpt", [LIST_A, LIST_B]),
            FakeEngine("perplexity", [LIST_B, RuntimeError("HTTP 429: rate limited")]),
            FakeEngine("gemini", [LIST_G])]


def test_track_question_aggregates_shares_brands_and_sources():
    opts = TrackOptions(samples=2, brands=["Brooks", "Nike", "Saucony"], location=Location("US"))
    result = asyncio.run(track_question("best running shoes for flat feet", engines_under_test(), opts,
                                        MemoryCache(), NOW))
    assert result["answers"] == {"total": 5, "new": 5, "reused": 0, "failed": 1}
    top = result["topRecommendations"][0]
    assert top["name"] == "Brooks Adrenaline GTS 24" and top["answers"] == 5 and top["share"] == 1.0
    assert top["engines"] == ["ChatGPT", "Perplexity", "Gemini"]
    brands = {b["brand"]: b for b in result["brands"]}
    assert brands["Brooks"]["mentionedIn"] == 5 and brands["Brooks"]["bestRank"] == 1
    assert brands["Nike"]["mentionedIn"] == 0 and brands["Saucony"]["byEngine"] == {
        "ChatGPT": "1/2", "Perplexity": "1/1", "Gemini": "0/2"}
    assert result["topSources"][0] == {"domain": "runnersworld.com", "citations": 3, "engines": ["ChatGPT", "Gemini"]}
    perplexity = next(e for e in result["engines"] if e["engine"] == "perplexity")
    assert perplexity["answers"] == 1 and perplexity["failed"] == 1 and perplexity["errors"] == ["HTTP 429: rate limited"]
    assert result["summary"].startswith("5 answers from ChatGPT, Perplexity and Gemini. Most recommended: "
                                        "Brooks Adrenaline GTS 24 (5 of 5).")
    assert len(result["answerTexts"]) == 5


def test_second_ask_the_same_week_reuses_answers():
    engines = engines_under_test()
    cache = MemoryCache()
    opts = TrackOptions(samples=2)
    asyncio.run(track_question("best running shoes", engines, opts, cache, NOW))
    again = asyncio.run(track_question("Best  running shoes", engines, opts, cache, NOW))
    assert again["answers"] == {"total": 6, "new": 1, "reused": 5, "failed": 0}  # only the failed ask is repeated
    assert [len(e.calls) for e in engines] == [2, 3, 2]
    next_week = asyncio.run(track_question("best running shoes", engines, opts, cache,
                                           datetime(2026, 10, 2, tzinfo=timezone.utc)))
    assert next_week["answers"]["reused"] == 0


def test_no_reuse_when_turned_off():
    engine = FakeEngine("chatgpt", [LIST_A])
    cache = MemoryCache()
    opts = TrackOptions(samples=1, reuse_recent=False)
    asyncio.run(track_question("q", [engine], opts, cache, NOW))
    asyncio.run(track_question("q", [engine], opts, cache, NOW))
    assert len(engine.calls) == 2


def test_all_engines_failing_is_an_error_result():
    engine = FakeEngine("chatgpt", [RuntimeError("HTTP 500: down")])
    result = asyncio.run(track_question("q", [engine], TrackOptions(samples=2), None, NOW))
    assert result == {"question": "q", "error": "no AI engine answered: HTTP 500: down"}


def test_cache_key_varies_by_week_location_sample_and_model():
    base = cache_key("chatgpt", "m", "Best X", Location("US"), 1, "2026-W39")
    assert base == cache_key("chatgpt", "m", " best  x ", Location("us"), 1, "2026-W39")
    for other in (cache_key("chatgpt", "m", "best x", Location("GB"), 1, "2026-W39"),
                  cache_key("chatgpt", "m", "best x", Location("US"), 2, "2026-W39"),
                  cache_key("chatgpt", "m", "best x", Location("US"), 1, "2026-W40"),
                  cache_key("chatgpt", "m2", "best x", Location("US"), 1, "2026-W39")):
        assert other != base
    assert base.startswith("answer-") and len(base) < 64


def test_aggregate_without_lists_still_reports():
    answers = [(1, Answer("chatgpt", "m", text="It depends on your needs."))]
    result = aggregate("q", answers, [FakeEngine("chatgpt", [])], TrackOptions(), "now")
    assert result["topRecommendations"] == [] and "No product list" in result["summary"]


# --- actor input handling ---------------------------------------------------------

def test_collect_questions_dedupes_and_limits():
    questions, skipped = collect_questions({"questions": ["best x", "Best  X", " ", "y" * 400, 5, "best y"]})
    assert questions == ["best x", "best y"] and len(skipped) == 1


def test_engine_selection_and_options_bounds():
    assert selected_engines({}) == ["chatgpt", "perplexity", "gemini"]
    assert selected_engines({"engines": ["claude", "claude", "nope"]}) == ["claude"]
    opts = track_options({"samplesPerEngine": 99, "country": "us", "brands": [" Brooks ", "", "Brooks"]})
    assert opts.samples == 5 and opts.location == Location("US") and opts.brands == ["Brooks"]
    assert track_options({"country": ""}).location is None

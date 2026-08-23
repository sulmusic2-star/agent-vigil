#!/usr/bin/env python3
"""Build the dated Agent Vigil pain ledger from primary user reports.

GitHub dates and titles are refreshed from the public issue or discussion page.
Reddit dates and titles are retained from the search result captured during the
2026-08-23 research pass because Reddit blocks unattended page retrieval.
"""

from __future__ import annotations

import html
import json
import re
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "research"
OBSERVED = datetime(2026, 8, 23, tzinfo=timezone.utc)


def github(repo: str, number: int, category: str, relevance: str) -> dict[str, str]:
    kind = "discussions" if repo == "orgs/community" else "issues"
    return {
        "url": f"https://github.com/{repo}/{kind}/{number}",
        "category": category,
        "relevance": relevance,
    }


SOURCES = [
    github("openai/codex", 38495, "loops-and-cost", "Detect identical polling and spend after useful work has stopped."),
    github("openai/codex", 38335, "loops-and-cost", "Attribute task cost and expose retries, compactions and background work."),
    github("openai/codex", 34115, "environment-and-state", "Distinguish a live background process from a hung or unknown process."),
    github("openai/codex", 38437, "loops-and-cost", "Honor stop signals and detect continued paid activity after cancellation."),
    github("openai/codex", 35226, "environment-and-state", "Retain progress across compaction and flag repeated rereads."),
    github("openai/codex", 35050, "loops-and-cost", "Measure repeated turns and the cost of avoidable serialization."),
    github("openai/codex", 32503, "loops-and-cost", "Measure tool-call efficiency without treating activity as progress."),
    github("openai/codex", 34971, "loops-and-cost", "Detect repeated context processing, timeouts and recovery loops."),
    github("openai/codex", 38132, "environment-and-state", "Require terminal evidence when orchestration cannot observe worker state."),
    github("openai/codex", 35528, "environment-and-state", "Preserve exact residual state and refuse unsupported completion."),
    github("openai/codex", 38157, "pricing-and-attribution", "Keep billed usage separate from plan labels and self-reported estimates."),
    github("openai/codex", 38191, "pricing-and-attribution", "Bind cost evidence to a task and observation time."),
    github("openai/codex", 38233, "pricing-and-attribution", "Compare agent versions with measured task cost and outcome."),
    github("openai/codex", 38309, "pricing-and-attribution", "Fail closed when cost cannot be attributed to visible work."),
    github("openai/codex", 22390, "environment-and-state", "Record partial work, bounded retries and retained recovery state."),
    github("anthropics/claude-code", 81531, "loops-and-cost", "Use an external liveness signal instead of process existence alone."),
    github("anthropics/claude-code", 81359, "loops-and-cost", "Detect restart storms, repeat-fail cycles and spend without progress."),
    github("anthropics/claude-code", 85206, "loops-and-cost", "Detect identical retries that restart from zero and produce no change."),
    github("anthropics/claude-code", 45958, "loops-and-cost", "Retain subagent progress and quantify stalls before retrying."),
    github("anthropics/claude-code", 26171, "loops-and-cost", "Set evidence-backed limits on thinking with no output or tool activity."),
    github("anthropics/claude-code", 24147, "pricing-and-attribution", "Separate productive work from repeated cached-context overhead."),
    github("anthropics/claude-code", 20223, "pricing-and-attribution", "Expose avoidable input overhead instead of reporting only totals."),
    github("anthropics/claude-code", 24044, "environment-and-state", "Detect duplicate context injection and configuration drift."),
    github("anthropics/claude-code", 22607, "pricing-and-attribution", "Provide cumulative task-visible cost and cache accounting."),
    github("anthropics/claude-code", 26762, "pricing-and-attribution", "Keep calculated cost, billed cost and subscription allocation distinct."),
    github("anthropics/claude-code", 63861, "false-completion", "Require the canonical build before accepting verified or done."),
    github("anthropics/claude-code", 42835, "permissions-and-tools", "Record tool availability changes and refuse fabricated unavailability claims."),
    github("anthropics/claude-code", 42148, "permissions-and-tools", "Preflight required tools before unattended work begins."),
    github("anthropics/claude-code", 33073, "permissions-and-tools", "Treat policy-hook deadlocks as a failed control, not successful enforcement."),
    github("anthropics/claude-code", 35262, "permissions-and-tools", "Bound deferred-tool discovery and surface deadlocks explicitly."),
    github("anthropics/claude-code", 44536, "permissions-and-tools", "Measure context/tool loading cost before expanding integrations."),
    github("orgs/community", 196715, "review-and-outcome", "Check actual merge readiness instead of trusting a completed checkbox."),
    github("orgs/community", 190036, "review-and-outcome", "Time out stuck review work and report an actionable failure."),
    github("orgs/community", 190754, "review-and-outcome", "Reconcile prior review disposition before repeating a rejected finding."),
    github("orgs/community", 197646, "false-completion", "Treat instruction compliance as evidence to verify, not a model promise."),
    github("orgs/community", 197976, "permissions-and-tools", "Verify that an assigned agent actually started and retained task state."),
    github("orgs/community", 170192, "environment-and-state", "Distinguish service failure from repository failure in the receipt."),
    github("openai/codex", 19910, "false-completion", "Keep completion criteria and remaining work durable across compaction."),
    github("openai/codex", 34591, "review-and-outcome", "Retain review context when work moves between parent and child agents."),
    github("orgs/community", 189795, "environment-and-state", "Expose service incidents so missing reviews do not look like clean work."),
    {
        "url": "https://www.reddit.com/r/ClaudeCode/comments/1rug14a/claude_wrote_playwright_tests_that_secretly/",
        "published_at": "2026-03-15T00:00:00Z",
        "title": "Claude wrote Playwright tests that secretly patched the app so they would pass",
        "category": "test-integrity",
        "relevance": "Detect tests that mutate the application under test before asserting success.",
    },
    {
        "url": "https://www.reddit.com/r/ClaudeCode/comments/1ukfze0/tired_of_claude_code_saying_done_tests_pass_and/",
        "published_at": "2026-07-01T00:00:00Z",
        "title": "Tired of Claude Code saying done, tests pass and leaving a stub",
        "category": "false-completion",
        "relevance": "Require independent evidence for done and tests-pass claims.",
    },
    {
        "url": "https://www.reddit.com/r/ClaudeCode/comments/1txcow8/my_test_suite_is_green_for_the_first_time_in/",
        "published_at": "2026-06-05T00:00:00Z",
        "title": "My test suite is green for the first time in weeks. I have never trusted it less.",
        "category": "test-integrity",
        "relevance": "Detect disabled checks, no-verify bypasses and weakened test oracles.",
    },
    {
        "url": "https://www.reddit.com/r/claudeskills/comments/1ul91r4/my_claude_code_agents_kept_saying_done_all_tests/",
        "published_at": "2026-07-02T00:00:00Z",
        "title": "Agents said done and all tests passing while important buttons did nothing",
        "category": "false-completion",
        "relevance": "Require a check outside the agent loop and support observable behavior tests.",
    },
    {
        "url": "https://www.reddit.com/r/ClaudeCode/comments/1v39e95/claude_keeps_writing_tests_that_pass_im_not/",
        "published_at": "2026-07-22T00:00:00Z",
        "title": "Claude keeps writing tests that pass. I am not convinced they prove anything.",
        "category": "test-integrity",
        "relevance": "Flag tests that remain green under nearby implementation mutations.",
    },
    {
        "url": "https://www.reddit.com/r/ClaudeCode/comments/1qp7qbe/claude_code_loves_breaking_stuff_and_then/",
        "published_at": "2026-01-28T00:00:00Z",
        "title": "Claude Code loves breaking stuff and then declaring it an existing error",
        "category": "false-completion",
        "relevance": "Compare failures against the base revision before calling them pre-existing.",
    },
    {
        "url": "https://www.reddit.com/r/ClaudeAI/comments/1s7mkn3/psa_claude_code_has_two_cache_bugs_that_can/",
        "published_at": "2026-03-30T00:00:00Z",
        "title": "Cache bugs can silently increase Claude Code API costs",
        "category": "pricing-and-attribution",
        "relevance": "Preserve provider evidence and show cost anomalies separately from outcome.",
    },
    {
        "url": "https://www.reddit.com/r/coderabbit/comments/1u5b0q8/why_i_am_cancelling_coderabbit/",
        "published_at": "2026-06-01T00:00:00Z",
        "title": "Why I am cancelling CodeRabbit",
        "category": "pricing-and-attribution",
        "relevance": "Use transparent limits and show the unit that causes additional charges.",
    },
    {
        "url": "https://www.reddit.com/r/coderabbit/comments/1vuj1jz/day_7_of_paying_for_pro_and_not_being_able_to_use/",
        "published_at": "2026-08-22T00:00:00Z",
        "title": "Day 7 of paying for Pro+ and not being able to use it",
        "category": "pricing-and-attribution",
        "relevance": "Avoid surprise file-based charges for high-throughput agent changes.",
    },
    {
        "url": "https://www.reddit.com/r/coderabbit/comments/1vkv76b/gitlab_and_coderabbit/",
        "published_at": "2026-08-16T00:00:00Z",
        "title": "GitLab and CodeRabbit runner configuration problem",
        "category": "environment-and-state",
        "relevance": "Doctor installation and distinguish webhook success from runner readiness.",
    },
]

REPRESENTATIVE_QUOTES = {
    "https://github.com/openai/codex/issues/38495": "Each such turn resubmits the entire conversation context.",
    "https://github.com/anthropics/claude-code/issues/85206": "4 attempts ... zero lines of code written.",
    "https://github.com/anthropics/claude-code/issues/63861": "declared it genuinely done ... while never having run make -j4",
    "https://github.com/orgs/community/discussions/196715": "Many threads still open ... marked done anyway.",
    "https://github.com/orgs/community/discussions/190036": "runners stuck ... for as long as 6 hours",
    "https://www.reddit.com/r/ClaudeCode/comments/1rug14a/claude_wrote_playwright_tests_that_secretly/": "patch the app at runtime",
}


def refresh_github(item: dict[str, str]) -> None:
    if not item["url"].startswith("https://github.com/"):
        return
    request = urllib.request.Request(item["url"], headers={"User-Agent": "agent-vigil-research/0.13"})
    with urllib.request.urlopen(request, timeout=20) as response:
        page = response.read().decode("utf-8", "replace")
    title = re.search(r'<meta property="og:title" content="([^"]+)"', page)
    date = re.search(r'"datePublished":"([^"]+)"', page) or re.search(
        r'<relative-time[^>]*datetime="([^"]+)"', page
    )
    if not title or not date:
        raise RuntimeError(f"primary-source metadata missing: {item['url']}")
    item["title"] = html.unescape(title.group(1))
    item["published_at"] = date.group(1)


def age_bucket(published_at: str) -> str:
    published = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    days = (OBSERVED - published).days
    if days <= 7:
        return "last-7-days"
    if days <= 31:
        return "last-31-days"
    if days <= 93:
        return "last-3-months"
    return "last-12-months"


def main() -> None:
    for item in SOURCES:
        refresh_github(item)
        item["window"] = age_bucket(item["published_at"])
        if item["url"] in REPRESENTATIVE_QUOTES:
            item["short_quote"] = REPRESENTATIVE_QUOTES[item["url"]]

    if len(SOURCES) != 50 or len({item["url"] for item in SOURCES}) != 50:
        raise RuntimeError("pain ledger must contain 50 unique primary sources")

    OUT.mkdir(parents=True, exist_ok=True)
    payload = {
        "observed_at": OBSERVED.isoformat().replace("+00:00", "Z"),
        "source_policy": "Primary user reports only. A report is evidence of experienced pain, not proof of root cause or prevalence.",
        "count": len(SOURCES),
        "by_category": dict(sorted(Counter(item["category"] for item in SOURCES).items())),
        "by_window": dict(sorted(Counter(item["window"] for item in SOURCES).items())),
        "sources": SOURCES,
    }
    (OUT / "2026-08-23-user-pain-ledger.json").write_text(json.dumps(payload, indent=2) + "\n")

    category_counts = Counter(item["category"] for item in SOURCES)
    window_counts = Counter(item["window"] for item in SOURCES)
    lines = [
        "# Coding-agent pain ledger",
        "",
        "Observed 2026-08-23. The 50 entries below are primary user reports. They prove that a person reported the problem; they do not prove the reporter's diagnosis or the market-wide rate.",
        "",
        "## Counts",
        "",
        *[f"- {name}: {count}" for name, count in sorted(category_counts.items())],
        "",
        "Time windows:",
        "",
        *[f"- {name}: {count}" for name, count in sorted(window_counts.items())],
        "",
        "## Sources",
        "",
    ]
    for index, item in enumerate(SOURCES, 1):
        day = item["published_at"][:10]
        lines.extend([
            f"### {index}. {item['title']}",
            "",
            f"- Date: {day}",
            f"- Window: {item['window']}",
            f"- Category: {item['category']}",
            f"- Source: {item['url']}",
            f"- Product implication: {item['relevance']}",
            *([f"- Short excerpt: \"{item['short_quote']}\""] if item.get("short_quote") else []),
            "",
        ])
    (OUT / "2026-08-23-user-pain-ledger.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()

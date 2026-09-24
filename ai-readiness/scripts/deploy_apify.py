#!/usr/bin/env python3
"""Set up the ai-readiness Actors on Apify: create or update, build, and test-run each one.

    APIFY_TOKEN=... python3 ai-readiness/scripts/deploy_apify.py

For every folder in ai-readiness/actors/ this script:

1. creates the Actor in your Apify account, or updates it if it already exists, with
   its Git source, title, descriptions, SEO text, Store categories and default run
   options (SEO text and categories come from store-assets/listing.json);
2. builds it and waits for the build to finish;
3. runs it once with the prefilled input from its input schema and checks that the
   run succeeds with a non-empty dataset. Apify Store runs the same test every day.

It never sets prices and never publishes. Apify needs your payout details before you
can set prices, and publishing is your decision; see GO_LIVE.md.

Options:
    --branch NAME   Git branch Apify builds from (default: main)
    --only NAME     set up only this Actor; repeat for several
    --skip-test     build without the test run
    --dry-run       print what would be sent, without calling Apify

Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]  # ai-readiness/
ACTORS_DIR = ROOT / "actors"
LISTING_FILE = ROOT / "store-assets" / "listing.json"
REPO_URL = "https://github.com/sulmusic2-star/agent-vigil"
API_BASE = "https://api.apify.com/v2"

# Category IDs that appear in Apify's API reference. listing.json may name others; if
# Apify rejects them, the Actor is saved with these only and you pick the rest in Console.
DOCUMENTED_CATEGORIES = {"AI", "DEVELOPER_TOOLS", "LEAD_GENERATION", "OPEN_SOURCE", "SOCIAL_MEDIA"}
UNFINISHED = {"READY", "RUNNING", "TIMING-OUT", "ABORTING"}
TEST_TIMEOUT_SECS = 300  # Apify Store's daily test expects a result within 5 minutes


class ApifyError(RuntimeError):
    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status
        self.message = message


def _error_text(body: str) -> str:
    try:
        error = json.loads(body).get("error") or {}
        return error.get("message") or error.get("type") or body[:300]
    except (ValueError, AttributeError):
        return body[:300]


class Apify:
    """Minimal Apify API v2 client."""

    def __init__(self, token: str, base: str = API_BASE, pause: float = 2.0) -> None:
        self.token = token
        self.base = base.rstrip("/")
        self.pause = pause

    def request(self, method: str, path: str, body: Any = None, params: dict[str, Any] | None = None,
                raw: bool = False) -> Any:
        url = self.base + path + ("?" + urlencode(params) if params else "")
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": "ai-readiness-deploy/1"}
        if data is not None:
            headers["Content-Type"] = "application/json; charset=utf-8"
        # Retry rate limits always; retry server errors only for requests that are safe to repeat.
        retry_on = {429} if method == "POST" else {429, 500, 502, 503, 504}
        for attempt in range(4):
            try:
                with urlopen(Request(url, data=data, method=method, headers=headers), timeout=120) as resp:
                    payload = resp.read()
                break
            except HTTPError as exc:
                text = exc.read().decode("utf-8", "replace")
                if exc.code in retry_on and attempt < 3:
                    time.sleep(self.pause * 2 ** attempt)
                    continue
                raise ApifyError(exc.code, _error_text(text)) from None
            except URLError as exc:
                if method != "POST" and attempt < 3:
                    time.sleep(self.pause * 2 ** attempt)
                    continue
                raise ApifyError(None, f"could not reach {self.base}: {exc.reason}") from None
        if raw:
            return payload.decode("utf-8", "replace")
        parsed = json.loads(payload or b"null")
        return parsed["data"] if isinstance(parsed, dict) and "data" in parsed else parsed


@dataclass
class ActorSpec:
    name: str
    definition: dict[str, Any]
    listing: dict[str, Any]
    test_input: dict[str, Any]


@dataclass
class Result:
    name: str
    action: str = ""
    build: str = ""
    test: str = ""
    items: int | None = None
    ok: bool = False
    notes: list[str] = field(default_factory=list)


def load_actors(only: list[str] | None = None) -> list[ActorSpec]:
    listing = json.loads(LISTING_FILE.read_text(encoding="utf-8"))
    specs = []
    for folder in sorted(p for p in ACTORS_DIR.iterdir() if (p / ".actor" / "actor.json").is_file()):
        if only and folder.name not in only:
            continue
        definition = json.loads((folder / ".actor" / "actor.json").read_text(encoding="utf-8"))
        schema = json.loads((folder / ".actor" / "input_schema.json").read_text(encoding="utf-8"))
        test_input = {key: prop["prefill"] for key, prop in schema["properties"].items() if "prefill" in prop}
        specs.append(ActorSpec(folder.name, definition, listing[folder.name], test_input))
    unknown = sorted(set(only or ()) - {s.name for s in specs})
    if unknown:
        raise SystemExit(f"Unknown Actor(s): {', '.join(unknown)}")
    return specs


def actor_payload(spec: ActorSpec, branch: str, categories: list[str] | None = None) -> dict[str, Any]:
    definition = spec.definition
    return {
        "name": spec.name,
        "title": definition["title"],
        "description": definition["description"],
        "seoTitle": spec.listing["seoTitle"],
        "seoDescription": spec.listing["seoDescription"],
        "categories": list(spec.listing["categories"] if categories is None else categories),
        "versions": [{
            "versionNumber": definition["version"],
            "sourceType": "GIT_REPO",
            "gitRepoUrl": f"{REPO_URL}#{branch}:ai-readiness/actors/{spec.name}",
            "buildTag": "latest",
        }],
        "defaultRunOptions": {
            "build": "latest",
            "memoryMbytes": definition.get("defaultMemoryMbytes", 512),
            "timeoutSecs": 3600,
        },
    }


def upsert(api: Apify, username: str, spec: ActorSpec, branch: str, notes: list[str]) -> tuple[dict, str]:
    try:
        existing = api.request("GET", f"/acts/{username}~{spec.name}")
    except ApifyError as exc:
        if exc.status != 404:
            raise
        existing = None
    method, path = ("PUT", f"/acts/{existing['id']}") if existing else ("POST", "/acts")
    payload = actor_payload(spec, branch)
    try:
        actor = api.request(method, path, payload)
    except ApifyError as exc:
        if exc.status != 400 or "categor" not in exc.message.lower():
            raise
        kept = [c for c in payload["categories"] if c in DOCUMENTED_CATEGORIES]
        notes.append(f"Apify did not accept categories {payload['categories']}, so it was saved with {kept}. "
                     "Pick the closest remaining category in Console.")
        actor = api.request(method, path, actor_payload(spec, branch, kept))
    return actor, ("updated" if existing else "created")


def _wait(api: Apify, job: dict, path: str, deadline: float) -> dict:
    while job["status"] in UNFINISHED and time.monotonic() < deadline:
        job = api.request("GET", f"{path}/{job['id']}", params={"waitForFinish": 60})
    return job


def build(api: Apify, actor_id: str, version: str, limit_secs: int = 900) -> dict:
    job = api.request("POST", f"/acts/{actor_id}/builds",
                      params={"version": version, "tag": "latest", "waitForFinish": 60})
    return _wait(api, job, "/actor-builds", time.monotonic() + limit_secs)


def test_run(api: Apify, actor_id: str, run_input: dict[str, Any]) -> tuple[dict, list, dict | None]:
    run = api.request("POST", f"/acts/{actor_id}/runs", run_input,
                      params={"build": "latest", "memory": 512, "timeout": TEST_TIMEOUT_SECS, "waitForFinish": 60})
    run = _wait(api, run, "/actor-runs", time.monotonic() + TEST_TIMEOUT_SECS + 120)
    items = api.request("GET", f"/datasets/{run['defaultDatasetId']}/items", params={"clean": "true", "limit": 1000})
    try:
        summary = api.request("GET", f"/key-value-stores/{run['defaultKeyValueStoreId']}/records/OUTPUT")
    except ApifyError:
        summary = None
    return run, items if isinstance(items, list) else [], summary if isinstance(summary, dict) else None


def _log_tail(api: Apify, job_id: str, lines: int = 25) -> str:
    try:
        text = api.request("GET", f"/logs/{job_id}", raw=True)
    except ApifyError as exc:
        return f"(log unavailable: {exc})"
    return "\n".join(text.rstrip().splitlines()[-lines:])


def deploy(api: Apify, specs: list[ActorSpec], branch: str, run_tests: bool = True,
           log: Callable[[str], None] = print) -> list[Result]:
    username = api.request("GET", "/users/me")["username"]
    log(f"Apify account: {username}")
    results = []
    for spec in specs:
        result = Result(spec.name)
        results.append(result)
        try:
            actor, result.action = upsert(api, username, spec, branch, result.notes)
            log(f"{spec.name}: {result.action}, building from branch {branch} ...")
            job = build(api, actor["id"], spec.definition["version"])
            result.build = job["status"]
            if job["status"] != "SUCCEEDED":
                result.notes.append("build log ends with:\n" + _log_tail(api, job["id"]))
                continue
            if not run_tests:
                result.ok = True
                continue
            log(f"{spec.name}: built, running a test with the prefilled input ...")
            run, items, summary = test_run(api, actor["id"], spec.test_input)
            result.test, result.items = run["status"], len(items)
            result.ok = run["status"] == "SUCCEEDED" and len(items) > 0
            if summary and summary.get("couldNotCheck"):
                skipped = "; ".join(f"{f.get('input')} ({f.get('reason')})" for f in summary["couldNotCheck"])
                result.notes.append(f"not checked in the test run: {skipped}")
            if not result.ok:
                result.notes.append("test run log ends with:\n" + _log_tail(api, run["id"]))
            result.notes.append(f"test run: https://console.apify.com/actors/runs/{run['id']}")
        except ApifyError as exc:
            result.notes.append(f"Apify API error: {exc}")
    return results


def report(results: list[Result]) -> str:
    lines = ["", f"{'Actor':<28} {'Setup':<8} {'Build':<10} {'Test':<10} {'Results':>7}  OK"]
    for r in results:
        items = "" if r.items is None else str(r.items)
        lines.append(f"{r.name:<28} {r.action:<8} {r.build:<10} {r.test:<10} {items:>7}  {'yes' if r.ok else 'NO'}")
    for r in results:
        for note in r.notes:
            lines.append(f"\n{r.name}: {note}")
    if results and all(r.ok for r in results):
        lines.append("\nAll Actors are built and working. Next: set prices and publish in Apify Console "
                     "(GO_LIVE.md, steps 4-6).")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--branch", default="main", help="Git branch Apify builds from (default: main)")
    parser.add_argument("--only", action="append", metavar="NAME", help="set up only this Actor; repeatable")
    parser.add_argument("--skip-test", action="store_true", help="build without the test run")
    parser.add_argument("--dry-run", action="store_true", help="print what would be sent, without calling Apify")
    args = parser.parse_args(argv)

    specs = load_actors(args.only)
    if args.dry_run:
        for spec in specs:
            print(json.dumps(actor_payload(spec, args.branch), indent=2, ensure_ascii=False))
            print("test input:", json.dumps(spec.test_input, ensure_ascii=False), "\n")
        return 0
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        print("APIFY_TOKEN is not set. Create a token in Apify Console under Settings > API & Integrations.",
              file=sys.stderr)
        return 2
    api = Apify(token, os.environ.get("APIFY_API_BASE_URL", API_BASE))
    try:
        results = deploy(api, specs, args.branch, run_tests=not args.skip_test)
    except ApifyError as exc:
        print(f"Apify API error: {exc}", file=sys.stderr)
        return 1
    print(report(results))
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())

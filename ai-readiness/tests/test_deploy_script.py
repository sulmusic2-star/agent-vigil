"""scripts/deploy_apify.py against a fake Apify API served on 127.0.0.1."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("deploy_apify", ROOT / "scripts" / "deploy_apify.py")
deploy_apify = importlib.util.module_from_spec(_spec)
sys.modules["deploy_apify"] = deploy_apify
_spec.loader.exec_module(deploy_apify)

ACTOR_NAMES = sorted(p.name for p in (ROOT / "actors").iterdir() if (p / ".actor" / "actor.json").is_file())


class FakeApify:
    """Just enough of the Apify API v2 for the deploy script."""

    def __init__(self, existing=(), reject_categories=False, build_status="SUCCEEDED", run_items=1):
        self.actors = {name: {"id": f"id-{name}", "name": name} for name in existing}
        self.reject_categories = reject_categories
        self.build_status = build_status
        self.run_items = run_items
        self.calls: list[tuple[str, str, dict, object]] = []

    def handle(self, method, path, query, body, auth):
        self.calls.append((method, path, query, body))
        if auth != "Bearer tok":
            return 401, {"error": {"type": "token-not-valid", "message": "Authentication token is not valid."}}
        if (method, path) == ("GET", "/users/me"):
            return 200, {"data": {"username": "tester"}}
        if m := re.fullmatch(r"/acts/tester~([\w-]+)", path):
            if m.group(1) in self.actors:
                return 200, {"data": self.actors[m.group(1)]}
            return 404, {"error": {"type": "record-not-found", "message": "Actor was not found"}}
        if (method == "POST" and path == "/acts") or (method == "PUT" and path.startswith("/acts/id-")):
            if self.reject_categories and set(body["categories"]) - deploy_apify.DOCUMENTED_CATEGORIES:
                return 400, {"error": {"type": "invalid-input", "message": "Invalid value in field categories"}}
            actor = {"id": f"id-{body['name']}", "name": body["name"]}
            self.actors[body["name"]] = actor
            return (201 if method == "POST" else 200), {"data": actor}
        if m := re.fullmatch(r"/acts/id-([\w-]+)/builds", path):
            return 201, {"data": {"id": f"b-{m.group(1)}", "status": "RUNNING"}}
        if m := re.fullmatch(r"/actor-builds/b-([\w-]+)", path):
            return 200, {"data": {"id": f"b-{m.group(1)}", "status": self.build_status}}
        if m := re.fullmatch(r"/acts/id-([\w-]+)/runs", path):
            name = m.group(1)
            return 201, {"data": {"id": f"r-{name}", "status": "RUNNING",
                                  "defaultDatasetId": f"d-{name}", "defaultKeyValueStoreId": f"k-{name}"}}
        if m := re.fullmatch(r"/actor-runs/r-([\w-]+)", path):
            name = m.group(1)
            return 200, {"data": {"id": f"r-{name}", "status": "SUCCEEDED",
                                  "defaultDatasetId": f"d-{name}", "defaultKeyValueStoreId": f"k-{name}"}}
        if re.fullmatch(r"/datasets/d-[\w-]+/items", path):
            return 200, [{"url": f"https://site{i}.example/"} for i in range(self.run_items)]
        if re.fullmatch(r"/key-value-stores/k-[\w-]+/records/OUTPUT", path):
            return 200, {"requested": 2, "saved": 1, "couldNotCheck": [{"input": "https://x.example/", "reason": "HTTP 403"}]}
        if path.startswith("/logs/"):
            return 200, "step 1\nstep 2\nERROR: pip could not install requirements"
        return 404, {"error": {"type": "page-not-found", "message": f"no route {method} {path}"}}

    def calls_to(self, method, pattern):
        return [c for c in self.calls if c[0] == method and re.fullmatch(pattern, c[1])]


@pytest.fixture
def api_server(monkeypatch):
    servers = []

    def start(**options):
        fake = FakeApify(**options)

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                parts = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                status, payload = fake.handle(self.command, parts.path.removeprefix("/v2"),
                                              {k: v[0] for k, v in parse_qs(parts.query).items()},
                                              body, self.headers.get("Authorization"))
                data = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/plain" if isinstance(payload, str) else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = _serve

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        monkeypatch.setenv("APIFY_TOKEN", "tok")
        monkeypatch.setenv("APIFY_API_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}/v2")
        for var in ("NO_PROXY", "no_proxy"):
            monkeypatch.setenv(var, "127.0.0.1,localhost")
        return fake

    yield start
    for server in servers:
        server.shutdown()


def test_new_account_gets_all_actors_created_built_and_tested(api_server, capsys):
    fake = api_server()
    assert deploy_apify.main([]) == 0
    created = fake.calls_to("POST", "/acts")
    assert sorted(c[3]["name"] for c in created) == ACTOR_NAMES
    generator = next(c[3] for c in created if c[3]["name"] == "llms-txt-generator")
    version = generator["versions"][0]
    assert version["gitRepoUrl"] == "https://github.com/sulmusic2-star/agent-vigil#main:ai-readiness/actors/llms-txt-generator"
    assert version["sourceType"] == "GIT_REPO" and version["versionNumber"] == "0.1" and version["buildTag"] == "latest"
    assert generator["categories"] == ["SEO_TOOLS", "DEVELOPER_TOOLS"] and generator["seoTitle"].startswith("llms.txt Generator")
    assert generator["defaultRunOptions"]["memoryMbytes"] == 512
    runs = fake.calls_to("POST", r"/acts/id-[\w-]+/runs")
    assert len(runs) == len(ACTOR_NAMES)
    generator_run = next(c for c in runs if c[1] == "/acts/id-llms-txt-generator/runs")
    assert generator_run[3]["websites"] == ["www.python.org", "developer.mozilla.org"]  # the prefilled input
    assert generator_run[2]["timeout"] == "300" and generator_run[2]["memory"] == "512"
    out = capsys.readouterr().out
    assert "All Actors are built and working" in out and "HTTP 403" in out  # skipped inputs are reported


def test_existing_actor_is_updated_not_duplicated(api_server):
    fake = api_server(existing=["ai-crawler-access-checker"])
    assert deploy_apify.main(["--only", "ai-crawler-access-checker", "--only", "llms-txt-validator"]) == 0
    assert [c[1] for c in fake.calls_to("PUT", r"/acts/.*")] == ["/acts/id-ai-crawler-access-checker"]
    assert [c[3]["name"] for c in fake.calls_to("POST", "/acts")] == ["llms-txt-validator"]


def test_rejected_categories_fall_back_to_documented_ones(api_server, capsys):
    fake = api_server(reject_categories=True)
    assert deploy_apify.main(["--only", "product-schema-checker", "--skip-test"]) == 0
    attempts = fake.calls_to("POST", "/acts")
    assert attempts[0][3]["categories"] == ["ECOMMERCE", "SEO_TOOLS"]
    assert attempts[1][3]["categories"] == []  # neither is in Apify's documented list
    assert "did not accept categories" in capsys.readouterr().out


def test_failed_build_is_reported_with_its_log(api_server, capsys):
    fake = api_server(build_status="FAILED")
    assert deploy_apify.main(["--only", "llms-txt-validator"]) == 1
    out = capsys.readouterr().out
    assert "FAILED" in out and "ERROR: pip could not install requirements" in out
    assert not fake.calls_to("POST", r"/acts/id-[\w-]+/runs")  # no test run on a failed build


def test_test_run_with_empty_dataset_fails(api_server, capsys):
    api_server(run_items=0)
    assert deploy_apify.main(["--only", "ai-agent-readiness-audit"]) == 1
    assert "NO" in capsys.readouterr().out


def test_bad_token_stops_with_a_clear_error(api_server, monkeypatch, capsys):
    api_server()
    monkeypatch.setenv("APIFY_TOKEN", "wrong")
    assert deploy_apify.main([]) == 1
    assert "Authentication token is not valid" in capsys.readouterr().err


def test_missing_token_and_dry_run(monkeypatch, capsys):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    assert deploy_apify.main([]) == 2
    assert deploy_apify.main(["--dry-run", "--only", "llms-txt-validator", "--branch", "release"]) == 0
    assert "agent-vigil#release:ai-readiness/actors/llms-txt-validator" in capsys.readouterr().out


def test_listing_covers_every_actor_and_matches_go_live():
    listing = json.loads((ROOT / "store-assets" / "listing.json").read_text(encoding="utf-8"))
    go_live = (ROOT / "GO_LIVE.md").read_text(encoding="utf-8")
    assert sorted(listing) == ACTOR_NAMES
    for name, entry in listing.items():
        assert len(entry["seoTitle"]) <= 60 and len(entry["seoDescription"]) <= 160, name
        assert entry["seoTitle"] in go_live and entry["seoDescription"] in go_live, name
        assert f"${entry['pricePerResultUsd']:g} |" in go_live, name
        assert (ROOT / "store-assets" / "icons" / f"{name}.png").is_file(), name


def test_api_keys_become_secret_env_vars_and_missing_ones_are_reported(api_server, monkeypatch, capsys):
    fake = api_server()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-live-1")
    monkeypatch.setenv("GEMINI_API_KEY", "g-live-2")
    for name in ("PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    assert deploy_apify.main(["--only", "ai-product-recommendation-tracker", "--only", "llms-txt-validator",
                              "--skip-test"]) == 0
    bodies = {c[3]["name"]: c[3] for c in fake.calls_to("POST", "/acts")}
    assert bodies["ai-product-recommendation-tracker"]["versions"][0]["envVars"] == [
        {"name": "OPENAI_API_KEY", "value": "sk-live-1", "isSecret": True},
        {"name": "GEMINI_API_KEY", "value": "g-live-2", "isSecret": True}]
    assert "envVars" not in bodies["llms-txt-validator"]["versions"][0]  # needs no keys
    out = capsys.readouterr().out
    assert "Missing API keys (PERPLEXITY_API_KEY, ANTHROPIC_API_KEY)" in out and "sk-live-1" not in out


def test_dry_run_never_prints_api_keys(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-live-1")
    assert deploy_apify.main(["--dry-run", "--only", "ai-product-recommendation-tracker"]) == 0
    out = capsys.readouterr().out
    assert "sk-live-1" not in out and "(secret, from this environment)" in out

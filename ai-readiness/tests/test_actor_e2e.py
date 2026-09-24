"""Run real actors end to end: Apify SDK (local mode) + httpx + a local web server.

Each actor's main.py runs in a subprocess exactly as it would on Apify, with the
input in local storage. It audits a fixture site served over real HTTP on
127.0.0.1, and the test reads the dataset and OUTPUT record it wrote.
Skipped when the Apify SDK or httpx is not installed.
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytest.importorskip("apify")
pytest.importorskip("httpx")

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "site"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):  # keep test output clean
        pass


@pytest.fixture(scope="module")
def site_url():
    handler = functools.partial(_QuietHandler, directory=str(FIXTURE))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def run_actor(name: str, actor_input: dict, tmp_path: Path) -> tuple[list[dict], dict, str]:
    storage = tmp_path / "storage"
    kvs = storage / "key_value_stores" / "default"
    kvs.mkdir(parents=True)
    (kvs / "INPUT.json").write_text(json.dumps(actor_input))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("APIFY_", "ACTOR_"))}
    env.update({"PYTHONPATH": str(ROOT), "CRAWLEE_STORAGE_DIR": str(storage),
                "APIFY_LOCAL_STORAGE_DIR": str(storage), "NO_PROXY": "127.0.0.1,localhost",
                "no_proxy": "127.0.0.1,localhost"})
    proc = subprocess.run([sys.executable, str(ROOT / "actors" / name / "main.py")], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=120)
    log = proc.stdout + proc.stderr
    assert proc.returncode == 0, log
    items = []
    dataset_dir = storage / "datasets" / "default"
    for path in sorted(dataset_dir.glob("*.json")):
        if path.name.startswith("__"):
            continue  # metadata file
        items.append(json.loads(path.read_text()))
    # The SDK's local storage keeps records under their bare key name.
    output_path = kvs / "OUTPUT"
    output = json.loads(output_path.read_text()) if output_path.exists() else {}
    return items, output, log


def test_crawler_access_actor(site_url, tmp_path):
    items, output, log = run_actor("ai-crawler-access-checker", {"websites": [site_url]}, tmp_path)
    assert len(items) == 1, log
    item = items[0]
    assert item["reachable"] and item["robotsTxt"]["state"] == "parsed"
    status = {a["agent"]: a["status"] for a in item["agents"]}
    assert status["GPTBot"] == "blocked" and status["CCBot"] == "blocked" and status["ClaudeBot"] == "allowed"
    assert item["contentSignals"] == {"search": "yes", "ai-train": "no"}
    assert output["saved"] == 1 and output["couldNotCheck"] == []


def test_readiness_actor(site_url, tmp_path):
    items, _, log = run_actor("ai-agent-readiness-audit", {"websites": [site_url]}, tmp_path)
    assert len(items) == 1, log
    item = items[0]
    assert 0 < item["score"] <= 100 and item["grade"] in "ABCDF"
    assert item["webmcp"]["declarativeTools"][0]["name"] == "search_products"
    assert item["discovery"]["a2aAgentCard"]["present"]
    assert item["llmsTxt"]["valid"]
    assert not item["webmcp"]["secureContext"]  # served over plain HTTP in the test


def test_llms_generator_saves_a_file(site_url, tmp_path):
    items, _, log = run_actor("llms-txt-generator", {"websites": [site_url], "maxPages": 10}, tmp_path)
    assert len(items) == 1, log
    item = items[0]
    assert item["draftValid"] and item["llmsTxt"].startswith("# Fixture Shop")
    saved = tmp_path / "storage" / "key_value_stores" / "default"
    assert any(p.name.startswith(item["llmsTxtFileKey"]) for p in saved.iterdir()), list(saved.iterdir())


def test_product_actor_and_unreachable_site_not_charged(site_url, tmp_path):
    items, output, log = run_actor("product-schema-checker", {
        "productUrls": [f"{site_url}/product.html", f"{site_url}/missing.html", "http://127.0.0.1:9/nothing"],
    }, tmp_path)
    assert len(items) == 1, log
    assert items[0]["productName"] == "Trail Runner" and items[0]["score"] > 0
    assert output["saved"] == 1 and len(output["couldNotCheck"]) == 2


def test_monitoring_reports_changes_between_runs(site_url, tmp_path):
    first, _, log = run_actor("llms-txt-validator", {"websites": [site_url], "monitorChanges": True}, tmp_path / "a")
    assert first and first[0]["firstCheck"] is True and first[0]["changes"] == [], log

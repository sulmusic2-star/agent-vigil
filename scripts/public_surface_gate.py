#!/usr/bin/env python3
"""Objective checks for Agent Vigil's public entry points.

This catches repeatable release mistakes. It does not claim that a human read or
approved the page. The separate checklist records what a reviewer still needs to
judge.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_TEXT = [ROOT / "README.md", ROOT / "docs/index.html", ROOT / "docs/ATTESTED_RECEIPTS.md", ROOT / "docs/NOTARY_APP.md"]
PUBLIC_HTML = [ROOT / "docs/index.html", ROOT / "docs/assets/agent-value-card-demo.html", ROOT / "docs/assets/agent-value-comparison-demo.html"]
INTERNAL_TERMS = {
    "product hypothesis", "commercial hypothesis", "commercial gate", "revenue hypothesis",
    "make millions", "guaranteed revenue", "internal talk", "workslop", "dogfood",
    "unreleased local experiment",
}
TEMPLATE_CSS = {
    "radial-gradient(": "decorative radial gradient",
    "linear-gradient(": "decorative gradient",
    "border-radius:999": "pill-shaped container",
    "border-radius: 999": "pill-shaped container",
    "box-shadow:": "decorative box shadow",
    "font-family:inter": "default Inter font",
    "font-family: inter": "default Inter font",
}

class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.buttons: list[str] = []
        self.images: list[dict[str, str]] = []
        self.iframes: list[dict[str, str]] = []
        self._anchor: list[str] | None = None
        self.visible: list[str] = []
        self._hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = {key: value or "" for key, value in attrs}
        if tag in {"style", "script"}:
            self._hidden_depth += 1
        if tag == "a":
            self.links.append(data.get("href", ""))
            self._anchor = []
        elif tag == "img":
            self.images.append(data)
        elif tag == "iframe":
            self.iframes.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"style", "script"} and self._hidden_depth:
            self._hidden_depth -= 1
        if tag == "a" and self._anchor is not None:
            self.buttons.append(" ".join(self._anchor).strip())
            self._anchor = None

    def handle_data(self, data: str) -> None:
        if self._hidden_depth == 0 and data.strip():
            self.visible.append(data.strip())
        if self._anchor is not None and data.strip():
            self._anchor.append(data.strip())


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def version_failures() -> list[str]:
    package_version = json.loads((ROOT / "package.json").read_text())["version"]
    report_source = (ROOT / "src/report.ts").read_text()
    failures: list[str] = []
    if f'VERSION = "{package_version}"' not in report_source:
        failures.append("src/report.ts VERSION differs from package.json")
    for path in [ROOT / "README.md", ROOT / "docs/index.html", ROOT / "docs/ATTESTED_RECEIPTS.md"]:
        if f"@sulmusic/agent-vigil@{package_version}" not in path.read_text():
            failures.append(f"{relative(path)} does not show the current package version {package_version}")
    return failures


def text_failures() -> list[str]:
    failures: list[str] = []
    for path in PUBLIC_TEXT:
        text = path.read_text().lower()
        for term in sorted(INTERNAL_TERMS):
            if term in text:
                failures.append(f"{relative(path)} contains internal-facing phrase: {term}")
    return failures


def resolve_local_link(page: Path, href: str) -> Path | None:
    if not href or href.startswith(("#", "http://", "https://", "mailto:")):
        return None
    return (page.parent / href.split("#", 1)[0].split("?", 1)[0]).resolve()


def html_failures() -> list[str]:
    failures: list[str] = []
    for path in PUBLIC_HTML:
        raw = path.read_text()
        folded = re.sub(r"\s+", "", raw.lower())
        parser = PageParser()
        parser.feed(raw)
        for pattern, label in TEMPLATE_CSS.items():
            if pattern.replace(" ", "") in folded:
                failures.append(f"{relative(path)} uses a discouraged template default: {label}")
        if "<meta name=\"viewport\"" not in raw and "<meta name='viewport'" not in raw:
            failures.append(f"{relative(path)} has no viewport declaration")
        for link in parser.links:
            target = resolve_local_link(path, link)
            if target is not None and not target.exists():
                failures.append(f"{relative(path)} links to missing local file: {link}")
        for image in parser.images:
            if not image.get("alt", "").strip():
                failures.append(f"{relative(path)} has an image without useful alt text")
        for frame in parser.iframes:
            if not frame.get("title", "").strip():
                failures.append(f"{relative(path)} has an iframe without a title")
        visible = " ".join(parser.visible)
        if "—" in visible:
            failures.append(f"{relative(path)} uses an em dash in visible copy; use a sentence or colon")
        long_sentences = [s.strip() for s in re.split(r"[.!?]+", visible) if len(re.findall(r"\b[\w'-]+\b", s)) > 35]
        if long_sentences:
            failures.append(f"{relative(path)} has {len(long_sentences)} sentence(s) over 35 words")
    landing = (ROOT / "docs/index.html").read_text().lower()
    if "body {" not in landing or "var(--font-body)" not in landing:
        failures.append("docs/index.html does not set its body in the reading font")
    if "font-size: 17px" not in landing and "font: 17px/" not in landing:
        failures.append("docs/index.html body text is below or different from the reviewed 17px size")
    if "max-width: 68ch" not in landing:
        failures.append("docs/index.html has no 68-character reading measure")
    if "overflow-x: clip" not in landing:
        failures.append("docs/index.html has no explicit horizontal-overflow guard")
    return failures


def run_checks() -> list[str]:
    return version_failures() + text_failures() + html_failures()


def self_test() -> None:
    parser = PageParser()
    parser.feed('<a href="guide.html">Read the guide</a><img src="x.png" alt="Receipt example">')
    assert parser.links == ["guide.html"]
    assert parser.buttons == ["Read the guide"]
    assert parser.images[0]["alt"] == "Receipt example"
    assert resolve_local_link(ROOT / "docs/index.html", "ATTESTED_RECEIPTS.md") == (ROOT / "docs/ATTESTED_RECEIPTS.md").resolve()
    assert "product hypothesis" in INTERNAL_TERMS
    print("public surface gate self-test: PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    failures = run_checks()
    if failures:
        print("Public surface gate: FAIL", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        print("\nThis automated gate does not replace the named human review in docs/PUBLIC_RELEASE_REVIEW.md.", file=sys.stderr)
        return 1
    print("Public surface gate: PASS")
    print(f"Checked {len(PUBLIC_TEXT)} public text files and {len(PUBLIC_HTML)} rendered HTML files.")
    print("Human approval is still required by docs/PUBLIC_RELEASE_REVIEW.md.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

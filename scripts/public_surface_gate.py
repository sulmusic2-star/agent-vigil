#!/usr/bin/env python3
"""Fail-closed, repeatable checks for Agent Vigil's public entry points."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_TEXT = [
    ROOT / "README.md",
    ROOT / "docs/index.html",
    ROOT / "docs/check.html",
    ROOT / "docs/ATTESTED_RECEIPTS.md",
    ROOT / "docs/HOSTED_SECURITY_CONTRACT.md",
    ROOT / "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md",
    ROOT / "docs/NOTARY_APP.md",
]
PUBLIC_HTML = [
    ROOT / "docs/index.html",
    ROOT / "docs/check.html",
    ROOT / "docs/assets/agent-value-card-demo.html",
    ROOT / "docs/assets/agent-value-comparison-demo.html",
    ROOT / "docs/assets/outcome-verifier-demo.html",
]
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
GENERIC_ACTIONS = {"click here", "learn more", "get started", "submit"}

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


def stable_version_tuple(value: object) -> tuple[int, int, int] | None:
    stable_part = r"(?:0|[1-9][0-9]*)"
    if not isinstance(value, str) or not re.fullmatch(
        rf"{stable_part}\.{stable_part}\.{stable_part}",
        value,
    ):
        return None
    return tuple(int(part) for part in value.split("."))  # type: ignore[return-value]


def utc_instant(value: object) -> datetime | None:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z",
        value,
    ):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def release_asset_url(version: str) -> str:
    asset = f"sulmusic-agent-vigil-{version}.tgz"
    return f"https://github.com/sulmusic2-star/agent-vigil/releases/download/v{version}/{asset}"


def npm_reference_failures(
    label: str,
    text: str,
    published_registry_version: str | None,
) -> list[str]:
    failures: list[str] = []
    for registry_spec in re.findall(
        r"@sulmusic/agent-vigil@([^\s`\"'<>]+)",
        text,
    ):
        if published_registry_version is None:
            failures.append(f"{label} presents an npm package before publication is recorded")
        elif registry_spec != published_registry_version:
            failures.append(f"{label} references an unrecorded npm package version or specifier")
    return failures


def install_reference_failures(
    label: str,
    text: str,
    release_version: str,
    candidate_version: str | None,
    published_registry_version: str | None,
) -> list[str]:
    failures: list[str] = []
    if release_asset_url(release_version) not in text:
        failures.append(f"{label} does not show the current GitHub release package")
    for url_version, asset_version in re.findall(
        r"https://github\.com/sulmusic2-star/agent-vigil/releases/download/v([0-9]+\.[0-9]+\.[0-9]+)/sulmusic-agent-vigil-([0-9]+\.[0-9]+\.[0-9]+)\.tgz",
        text,
    ):
        if url_version != asset_version or url_version != release_version:
            failures.append(f"{label} references an unrecorded or mismatched release package")
    failures.extend(npm_reference_failures(label, text, published_registry_version))
    if candidate_version is not None:
        candidate_url = release_asset_url(candidate_version)
        candidate_registry_spec = f"@sulmusic/agent-vigil@{candidate_version}"
        if candidate_url in text or candidate_registry_spec in text:
            failures.append(f"{label} presents the unpublished source candidate as installable")
    return failures


def install_state_failures(package_version: str, install_state: dict[str, object]) -> list[str]:
    release = install_state.get("latest_github_release", {})
    registry = install_state.get("npm_registry", {})
    candidate = install_state.get("source_release_candidate")
    if not isinstance(release, dict) or not isinstance(registry, dict):
        return ["docs/public-install-state.json has a malformed state section"]

    version = release.get("version")
    commit = release.get("commit")
    asset = release.get("asset")
    release_url = release.get("url")
    asset_url = release.get("asset_url")
    sha256 = release.get("sha256")
    target_version = registry.get("target_version")
    observed_version = registry.get("observed_version")
    observed_integrity = registry.get("observed_integrity")
    observed_published_at = registry.get("observed_published_at")
    target_published = registry.get("target_published")
    failures: list[str] = []

    if install_state.get("schema_version") != 1:
        failures.append("docs/public-install-state.json has an unsupported schema version")
    verified_at = install_state.get("verified_at")
    verified_instant = utc_instant(verified_at)
    if verified_instant is None:
        failures.append("docs/public-install-state.json has no UTC verification time")
    release_tuple = stable_version_tuple(version)
    if release_tuple is None:
        failures.append("docs/public-install-state.json has no valid GitHub release version")
        return failures
    package_tuple = stable_version_tuple(package_version)
    if package_tuple is None:
        failures.append("package.json does not contain a stable release version")
    elif version == package_version:
        if candidate is not None:
            failures.append("source release candidate remains after the package became the latest release")
    else:
        if not isinstance(candidate, dict):
            failures.append("stable package differs from the latest release without an explicit source candidate")
        else:
            expected_candidate_keys = {"version", "github_release_published", "npm_published"}
            if set(candidate) != expected_candidate_keys:
                failures.append("source release candidate has unexpected or missing fields")
            candidate_version = candidate.get("version")
            github_release_published = candidate.get("github_release_published")
            npm_published = candidate.get("npm_published")
            candidate_tuple = stable_version_tuple(candidate_version)
            if candidate_version != package_version:
                failures.append("source release candidate differs from the stable package version")
            if candidate_tuple is None:
                failures.append("source release candidate version is not stable SemVer")
            elif candidate_tuple <= release_tuple:
                failures.append("source release candidate is not newer than the latest public release")
            for channel, published in [
                ("GitHub release", github_release_published),
                ("npm", npm_published),
            ]:
                if not isinstance(published, bool):
                    failures.append(f"source candidate {channel} publication state is not boolean")
                elif published:
                    failures.append(f"published source candidate must be promoted to current {channel} state")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        failures.append("GitHub release commit is not a full lowercase commit")
    if release_url != f"https://github.com/sulmusic2-star/agent-vigil/releases/tag/v{version}":
        failures.append("GitHub release URL does not match its version")
    if asset != f"sulmusic-agent-vigil-{version}.tgz":
        failures.append("GitHub release asset does not match its version")
    expected_asset_url = release_asset_url(version)
    if asset_url != expected_asset_url:
        failures.append("GitHub release asset URL does not match its release")
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        failures.append("GitHub release digest is not SHA-256")
    if release.get("immutable") is not True:
        failures.append("GitHub release is not recorded as immutable")
    if registry.get("package") != "@sulmusic/agent-vigil":
        failures.append("npm registry package name is not canonical")
    if target_version != version:
        failures.append("npm target differs from the latest GitHub release")
    if not isinstance(observed_version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", observed_version):
        failures.append("npm observed version is not valid")
    if not isinstance(observed_integrity, str) or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", observed_integrity):
        failures.append("npm observed integrity is not valid SHA-512")
    if not isinstance(target_published, bool):
        failures.append("npm target publication state is not boolean")
    elif target_published and observed_version != target_version:
        failures.append("npm target is marked published but the observed version differs")
    elif not target_published and observed_version == target_version:
        failures.append("npm target is marked unpublished but the observed version matches")
    observed_published_instant = utc_instant(observed_published_at)
    if observed_published_instant is None:
        failures.append("observed npm version has no exact UTC publication time")
    elif verified_instant is not None and observed_published_instant > verified_instant:
        failures.append("npm publication time is later than the state verification")
    if isinstance(candidate, dict) and candidate.get("version") == observed_version:
        failures.append("unpublished source candidate already matches the observed npm version")
    return failures


def version_failures() -> list[str]:
    package_version = json.loads((ROOT / "package.json").read_text())["version"]
    report_source = (ROOT / "src/report.ts").read_text()
    failures: list[str] = []
    if f'VERSION = "{package_version}"' not in report_source:
        failures.append("src/report.ts VERSION differs from package.json")

    try:
        install_state = json.loads((ROOT / "docs/public-install-state.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        return failures + [f"docs/public-install-state.json cannot be read: {error}"]
    if not isinstance(install_state, dict):
        return failures + ["docs/public-install-state.json must contain one object"]
    failures.extend(install_state_failures(package_version, install_state))
    if failures:
        return failures

    release = install_state["latest_github_release"]
    registry = install_state["npm_registry"]
    release_url = release["asset_url"]
    candidate = install_state.get("source_release_candidate")
    candidate_version = candidate.get("version") if isinstance(candidate, dict) else None
    current_install_files = [
        ROOT / "README.md",
        ROOT / "docs/index.html",
        ROOT / "docs/ATTESTED_RECEIPTS.md",
        ROOT / "docs/AUTHORITY_RECONCILIATION.md",
        ROOT / "docs/HOSTED_SECURITY_CONTRACT.md",
        ROOT / "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md",
        ROOT / "docs/PRIVATE_RECEIPT_GATE.md",
        ROOT / "docs/PUBLIC_PR_RECEIPT.md",
    ]
    for path in current_install_files:
        failures.extend(
            install_reference_failures(
                relative(path),
                path.read_text(),
                release["version"],
                candidate_version if isinstance(candidate_version, str) else None,
                registry["observed_version"],
            )
        )

    publishing = ROOT / "docs/PUBLISHING.md"
    failures.extend(
        npm_reference_failures(
            relative(publishing),
            publishing.read_text(),
            registry["observed_version"],
        )
    )

    guide = (ROOT / "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md").read_text()
    for required in [release_url, release["sha256"], release["commit"], registry["observed_version"]]:
        if required not in guide:
            failures.append(f"docs/INSTALL_WITHOUT_NPM_ACCOUNT.md is missing verified release state: {required}")
    registry_spec = f"@sulmusic/agent-vigil@{release['version']}"
    if registry["target_published"] is False and registry_spec in guide:
        failures.append("npm-free guide presents the unpublished target as a registry package")
    if registry["target_published"] is True and registry_spec not in guide:
        failures.append("npm-free guide omits the independently verified public registry package")

    stale_package_url = "releases/download/v0.21.0/sulmusic-agent-vigil-0.21.0.tgz"
    for path in [
        ROOT / "README.md",
        ROOT / "docs/index.html",
        ROOT / "docs/ATTESTED_RECEIPTS.md",
        ROOT / "docs/AUTHORITY_RECONCILIATION.md",
        ROOT / "docs/HOSTED_SECURITY_CONTRACT.md",
        ROOT / "docs/PRIVATE_RECEIPT_GATE.md",
        ROOT / "docs/PUBLIC_PR_RECEIPT.md",
    ]:
        if stale_package_url in path.read_text():
            failures.append(f"{relative(path)} still points to the superseded v0.21.0 package")
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
        for label in parser.buttons:
            if label.strip().lower() in GENERIC_ACTIONS:
                failures.append(f"{relative(path)} uses a generic action label: {label}")
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
    first_screen = " ".join(page_visible_text(ROOT / "docs/index.html")[:18]).lower()
    for phrase in ["agent vigil", "check the work before it merges", "exact commits", "evidence is missing"]:
        if phrase not in first_screen:
            failures.append(f"docs/index.html first screen does not explain the product with: {phrase}")
    result_page = (ROOT / "docs/assets/outcome-verifier-demo.html").read_text()
    compact_result = re.sub(r"\s+", "", result_page.lower())
    for required in [
        'data-result-view-version="1"',
        'aria-labelledby="result-title"',
        'aria-label="checkcounts"',
        'aria-label="resultactions"',
        'failed</div>',
        'passed</div>',
        'notchecked</div>',
        'reviewchangedfiles',
        'copyreproducecommand',
        'overflow-x:clip',
        '@media(max-width:540px)',
        'min-height:44px',
    ]:
        if required not in compact_result:
            failures.append(f"docs/assets/outcome-verifier-demo.html is missing result-view requirement: {required}")
    return failures


def page_visible_text(path: Path) -> list[str]:
    parser = PageParser()
    parser.feed(path.read_text())
    return parser.visible


def claim_consistency_failures() -> list[str]:
    sources = {
        "README.md": (ROOT / "README.md").read_text(),
        "docs/COMPATIBILITY.md": (ROOT / "docs/COMPATIBILITY.md").read_text(),
        "docs/index.html": (ROOT / "docs/index.html").read_text(),
    }
    patterns = {
        "README.md": r"(?m)^- (\d+) tests, including",
        "docs/COMPATIBILITY.md": r"npm test` executes \*\*(\d+) tests\*\*",
    }
    observed: dict[str, str] = {}
    failures: list[str] = []
    for name, pattern in patterns.items():
        match = re.search(pattern, sources[name])
        if not match:
            failures.append(f"{name} does not expose the public test count in the expected form")
        else:
            observed[name] = match.group(1)
    landing_match = re.search(
        r"trusted command observed (\d+) passing; (\d+) skipped",
        sources["docs/index.html"],
    )
    if not landing_match:
        failures.append("docs/index.html does not expose passing and skipped test counts in the expected form")
    else:
        observed["docs/index.html"] = str(int(landing_match.group(1)) + int(landing_match.group(2)))
    if len(set(observed.values())) > 1:
        failures.append("public test counts disagree: " + ", ".join(f"{name}={count}" for name, count in observed.items()))
    return failures


def run_checks() -> list[str]:
    return version_failures() + text_failures() + html_failures() + claim_consistency_failures()


def self_test() -> None:
    parser = PageParser()
    parser.feed('<a href="guide.html">Read the guide</a><img src="x.png" alt="Receipt example">')
    assert parser.links == ["guide.html"]
    assert parser.buttons == ["Read the guide"]
    assert parser.images[0]["alt"] == "Receipt example"
    assert resolve_local_link(ROOT / "docs/index.html", "ATTESTED_RECEIPTS.md") == (ROOT / "docs/ATTESTED_RECEIPTS.md").resolve()
    assert "product hypothesis" in INTERNAL_TERMS
    assert "learn more" in GENERIC_ACTIONS
    install_state = json.loads((ROOT / "docs/public-install-state.json").read_text())
    package_version = json.loads((ROOT / "package.json").read_text())["version"]
    assert install_state_failures(package_version, install_state) == []
    changed = json.loads(json.dumps(install_state))
    changed["latest_github_release"]["sha256"] = "not-a-digest"
    assert any("SHA-256" in failure for failure in install_state_failures(package_version, changed))
    changed = json.loads(json.dumps(install_state))
    changed["npm_registry"]["target_published"] = True
    changed["npm_registry"]["observed_version"] = "0.11.3"
    assert any("observed version differs" in failure for failure in install_state_failures(package_version, changed))
    changed = json.loads(json.dumps(install_state))
    del changed["npm_registry"]["observed_published_at"]
    assert any("no exact UTC publication time" in failure for failure in install_state_failures(package_version, changed))
    changed = json.loads(json.dumps(install_state))
    changed["npm_registry"]["observed_published_at"] = "2099-01-01T00:00:00Z"
    assert any("later than the state verification" in failure for failure in install_state_failures(package_version, changed))
    changed = json.loads(json.dumps(install_state))
    changed["npm_registry"]["observed_version"] = package_version
    assert any("marked unpublished" in failure for failure in install_state_failures(package_version, changed))

    release_major, release_minor, release_patch = stable_version_tuple(package_version)
    candidate_package_version = f"{release_major}.{release_minor}.{release_patch + 1}"
    candidate_state = json.loads(json.dumps(install_state))
    candidate_state["source_release_candidate"] = {
        "version": candidate_package_version,
        "github_release_published": False,
        "npm_published": False,
    }
    assert install_state_failures(candidate_package_version, candidate_state) == []
    changed = json.loads(json.dumps(candidate_state))
    del changed["source_release_candidate"]
    assert any("without an explicit source candidate" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["version"] = install_state["latest_github_release"]["version"]
    assert any("differs from the stable package" in failure for failure in install_state_failures(candidate_package_version, changed))
    assert any("not newer" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["github_release_published"] = True
    assert any("current GitHub release" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["github_release_published"] = "false"
    assert any("publication state is not boolean" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["npm_published"] = True
    assert any("current npm state" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["unexpected"] = True
    assert any("unexpected or missing" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    del changed["source_release_candidate"]["npm_published"]
    assert any("unexpected or missing" in failure for failure in install_state_failures(candidate_package_version, changed))
    changed = json.loads(json.dumps(candidate_state))
    changed["source_release_candidate"]["version"] = "not-semver"
    assert any("not stable SemVer" in failure for failure in install_state_failures(candidate_package_version, changed))
    assert stable_version_tuple("01.2.3") is None
    release_version = install_state["latest_github_release"]["version"]
    public_url = release_asset_url(release_version)
    candidate_version = candidate_package_version
    candidate_url = release_asset_url(candidate_version)
    published_registry_version = install_state["npm_registry"]["observed_version"]
    assert install_reference_failures("fixture", public_url, release_version, candidate_version, published_registry_version) == []
    current_registry_spec = f"@sulmusic/agent-vigil@{published_registry_version}"
    assert install_reference_failures(
        "fixture",
        public_url + "\n" + current_registry_spec,
        release_version,
        candidate_version,
        published_registry_version,
    ) == []
    assert any(
        "unpublished source candidate" in failure
        for failure in install_reference_failures(
            "fixture",
            public_url + "\n" + candidate_url,
            release_version,
            candidate_version,
            published_registry_version,
        )
    )
    assert any(
        "unrecorded npm package version" in failure
        for failure in install_reference_failures(
            "fixture",
            public_url + "\n" + current_registry_spec + "\n@sulmusic/agent-vigil@0.1.0",
            release_version,
            candidate_version,
            published_registry_version,
        )
    )
    for alternate_spec in [
        f"^{candidate_version}",
        f"~{release_version}",
        "latest",
        f"v{release_version}",
        f"{release_version}-beta.1",
        f"{release_version}/extra",
    ]:
        assert any(
            "unrecorded npm package version or specifier" in failure
            for failure in npm_reference_failures(
                "fixture",
                f"npx --yes @sulmusic/agent-vigil@{alternate_spec}",
                published_registry_version,
            )
        )
    assert any(
        "unrecorded npm package version" in failure
        for failure in install_reference_failures(
            "fixture",
            public_url + "\n@sulmusic/agent-vigil@99.0.0",
            release_version,
            candidate_version,
            published_registry_version,
        )
    )
    assert any(
        "unpublished source candidate" in failure
        for failure in install_reference_failures(
            "fixture",
            public_url + f"\n@sulmusic/agent-vigil@{candidate_version}",
            release_version,
            candidate_version,
            published_registry_version,
        )
    )
    assert any(
        "before publication is recorded" in failure
        for failure in install_reference_failures(
            "fixture",
            public_url + "\n" + current_registry_spec,
            release_version,
            candidate_version,
            None,
        )
    )
    promoted_version = candidate_version
    promoted_url = release_asset_url(promoted_version)
    assert any(
        "unrecorded npm package version" in failure
        for failure in install_reference_failures(
            "fixture",
            promoted_url + "\n@sulmusic/agent-vigil@0.21.1",
            promoted_version,
            None,
            promoted_version,
        )
    )
    assert npm_reference_failures(
        "docs/PUBLISHING.md",
        (ROOT / "docs/PUBLISHING.md").read_text(),
        published_registry_version,
    ) == []
    assert not version_failures()
    assert claim_consistency_failures() == []
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
        print("\nThe public release policy blocks this revision until every listed failure is fixed.", file=sys.stderr)
        return 1
    print("Public surface gate: PASS")
    print(f"Checked {len(PUBLIC_TEXT)} public text files and {len(PUBLIC_HTML)} rendered HTML files.")
    print("The automated public release policy passed; no human-review declaration is required by Agent Vigil.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

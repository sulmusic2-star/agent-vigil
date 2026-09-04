"""Check the instructions shipped in a package, independently of live channel state."""
from __future__ import annotations

import re

LIVE_STATE = "https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json"


def install_command(version: str) -> str:
    return f"npx --yes --package=@sulmusic/agent-vigil@{version} agent-vigil protect --repo ."


def package_document_failures(version: str, readme: str, guide: str) -> list[str]:
    failures: list[str] = []
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        return ["package version must be stable SemVer"]
    asset = f"sulmusic-agent-vigil-{version}.tgz"
    url = f"https://github.com/sulmusic2-star/agent-vigil/releases/download/v{version}/{asset}"
    for label, text in [("README.md", readme), ("docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", guide)]:
        if LIVE_STATE not in text:
            failures.append(f"{label}: missing live channel record link")
        # A release snapshot must not assert a publication event that happens later.
        if re.search(r"source release candidate|install the published|npm (?:still )?serves|npm served|verification snapshot|verified public GitHub package", text, re.I):
            failures.append(f"{label}: contains temporary publication status")
        if re.search(r"\b(?:from commit|with SHA-256)\s*`", text):
            failures.append(f"{label}: embeds a circular release identity instead of the checksum asset")
        for spec in re.findall(r"@sulmusic/agent-vigil@([^\s`\"'<>]+)", text):
            if spec != version:
                failures.append(f"{label}: npm command does not select this package version")
        for tag, filename in re.findall(r"releases/(?:download|tag)/v([0-9]+\.[0-9]+\.[0-9]+)(?:/sulmusic-agent-vigil-([0-9]+\.[0-9]+\.[0-9]+)\.tgz)?", text):
            if tag != version or (filename and filename != version):
                failures.append(f"{label}: GitHub link does not select this package version")
        for filename in re.findall(r"sulmusic-agent-vigil-([0-9]+\.[0-9]+\.[0-9]+)\.tgz", text):
            if filename != version:
                failures.append(f"{label}: tarball name does not select this package version")
        if url not in text:
            failures.append(f"{label}: missing this version's GitHub package URL")
    npm_block = f"npm view @sulmusic/agent-vigil@{version} version && \\\n  {install_command(version)}"
    if npm_block not in readme:
        failures.append("README.md: installation must stop if this exact npm version is unavailable")
    checksum_block = (
        f"curl -fLO \\\n  {url} && \\\ncurl -fLO \\\n  {url}.sha256 && \\\nshasum -a 256 -c {asset}.sha256 && \\\nnpx --yes ./{asset} protect --repo ."
    )
    if checksum_block not in guide:
        failures.append("installation guide: download and checksum failures must stop installation")
    if "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md" not in readme:
        failures.append("README.md: missing the packaged installation guide")
    if "npm view @sulmusic/agent-vigil version" in guide:
        failures.append("installation guide: checking latest does not establish this version's availability")
    return failures

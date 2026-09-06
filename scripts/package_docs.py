"""Check the instructions shipped in a package, independently of live channel state."""
from __future__ import annotations

import re
import shlex

LIVE_STATE = "https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json"
PUBLIC_INSTALL = "https://sulmusic2-star.github.io/agent-vigil/#install"
AVAILABILITY = "Availability is not implied. Use the public installation page if these assets are unavailable."


def shell_lines(text: str) -> str:
    return re.sub(r"\\\n[ \t]*", "", text.replace("\r\n", "\n"))


def package_document_failures(version: str, readme: str, guide: str) -> list[str]:
    failures: list[str] = []
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        return ["package version must be stable SemVer"]
    asset = f"sulmusic-agent-vigil-{version}.tgz"
    url = f"https://github.com/sulmusic2-star/agent-vigil/releases/download/v{version}/{asset}"
    install = f"npx --yes --package=./{asset} agent-vigil protect --repo ."
    common = install + ' --runner common --test-cmd "python3 -m pytest -q"'
    expected_commands = [shlex.split(install), shlex.split(common)]
    for label, text in [("README.md", readme), ("docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", guide)]:
        logical = shell_lines(text)
        if LIVE_STATE not in text:
            failures.append(f"{label}: missing live channel record link")
        if PUBLIC_INSTALL not in text or text.index(PUBLIC_INSTALL) > text.find(url):
            failures.append(f"{label}: public installation page must precede package downloads")
        if AVAILABILITY not in " ".join(text.split()):
            failures.append(f"{label}: missing conditional download availability disclosure")
        # A release snapshot must not assert a publication event that happens later.
        if re.search(r"source release candidate|install the published|npm (?:still )?serves|npm served|verification snapshot|verified public GitHub package", text, re.I):
            failures.append(f"{label}: contains temporary publication status")
        if re.search(r"\b(?:from commit|with SHA-256)\s*`", text):
            failures.append(f"{label}: embeds a circular release identity instead of the checksum asset")
        if re.search(r"@sulmusic/agent-vigil\b", text):
            failures.append(f"{label}: npm package specs belong on the verified public installation page")
        if re.search(r"\bnpx\s+[^\n]*https?://", logical):
            failures.append(f"{label}: execute the local checksum-verified package, not a fresh remote download")
        # These documents deliberately offer only two reviewed command shapes.
        # Check every invocation, not merely the presence of one safe example.
        try:
            commands = [shlex.split(match.group()) for match in re.finditer(r"\bnpx\b[^\n`]*", logical)]
        except ValueError:
            commands = []
        if commands != expected_commands:
            failures.append(f"{label}: extra or unsupported package execution outside the reviewed install sequence")
        for tag, filename in re.findall(r"releases/(?:download|tag)/v([0-9]+\.[0-9]+\.[0-9]+)(?:/sulmusic-agent-vigil-([0-9]+\.[0-9]+\.[0-9]+)\.tgz)?", text):
            if tag != version or (filename and filename != version):
                failures.append(f"{label}: GitHub link does not select this package version")
        for filename in re.findall(r"sulmusic-agent-vigil-([0-9]+\.[0-9]+\.[0-9]+)\.tgz", text):
            if filename != version:
                failures.append(f"{label}: tarball name does not select this package version")
        if url not in text:
            failures.append(f"{label}: missing this version's GitHub package URL")
    if install not in shell_lines(readme):
        failures.append("README.md: installation must use this exact downloaded package")
    checksum_block = (
        f"curl -fLO \\\n  {url} && \\\ncurl -fLO \\\n  {url}.sha256 && \\\nshasum -a 256 -c {asset}.sha256 && \\\nnpx --yes --package=./{asset} agent-vigil protect --repo ."
    )
    normalized_guide = shell_lines(guide)
    normalized_block = shell_lines(checksum_block)
    block_start = normalized_guide.find(normalized_block)
    first_install = re.search(r"\bnpx\b", normalized_guide)
    if block_start < 0 or not first_install or first_install.start() != block_start + normalized_block.index(install):
        failures.append("installation guide: download and checksum failures must stop installation")
    if "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md" not in readme:
        failures.append("README.md: missing the packaged installation guide")
    return failures

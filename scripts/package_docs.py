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
    doctor = f"npx --yes --package=./{asset} agent-vigil doctor --repo ."
    common = install + ' --runner common --test-cmd "python3 -m pytest -q"'
    checksum_block = (
        f"curl -fLO \\\n  {url} && \\\ncurl -fLO \\\n  {url}.sha256 && \\\nshasum -a 256 -c {asset}.sha256 && \\\n{install}"
    )
    repository_check = "\n".join([
        "git clone https://github.com/sulmusic2-star/agent-vigil.git",
        "cd agent-vigil", "npm ci", "npm run typecheck", "npm run build",
        "npm test", "npm run test:hosted", "npm run test:package",
    ])
    expected_blocks = {
        "README.md": [install, common, "vigil check https://github.com/OWNER/REPOSITORY/pull/123", repository_check],
        "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md": [checksum_block, doctor, common],
    }
    expected_commands = {label: [shlex.split(command) for command in commands] for label, commands in {
        "README.md": [install, common],
        "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md": [install, doctor, common],
    }.items()}
    for label, text in [("README.md", readme), ("docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", guide)]:
        logical = shell_lines(text)
        # Packaged instructions have a closed set of executable examples.
        # Do not interpret Bash expansion or accept newly introduced programs.
        if "$" in logical:
            failures.append(f"{label}: shell expansion and dollar-prefixed quoting are unsupported")
        if re.search(r"^(?:[ \t]*>|[ \t]{4,}\S)|^[ \t]*(?:[-+*]|\d+[.)])\s+.*(?:```|~~~)|<(?:pre|script|code)\b", logical, re.M | re.I):
            failures.append(f"{label}: nested, indented, or raw HTML executable examples are unsupported")
        blocks = re.findall(r"^```([^\n]*)\n(.*?)\n```[ \t]*$", logical, re.M | re.S)
        fences = re.findall(r"^(?:[ \t]*>[ \t]*)*[ \t]*(?:```|~~~)", logical, re.M)
        if len(fences) != 2 * len(blocks) or any(language not in ("bash", "text") for language, _ in blocks):
            failures.append(f"{label}: unsupported or malformed fenced example")
        executable_blocks = [body for language, body in blocks if language in ("bash", "sh", "shell", "")]
        if executable_blocks != [shell_lines(block) for block in expected_blocks[label]]:
            failures.append(f"{label}: executable examples differ from the reviewed literal command blocks")
        outside_fences = re.sub(r"^```[^\n]*\n.*?\n```[ \t]*$", "", logical, flags=re.M | re.S)
        if "``" in outside_fences or outside_fences.count("`") % 2:
            failures.append(f"{label}: inline identifiers require balanced single-backtick delimiters")
        inline_allowed = {
            "protect", "doctor", "PASS", "FAIL", "NOT CHECKED", "pull_request", "merge_group",
            "hosted/public-app", "docs/public-install-state.json", "public-install-state.json",
            "--runner-image", "vigil help", "vigil help --all", asset, asset + ".sha256",
        }
        for inline in re.findall(r"`([^`]*)`", outside_fences):
            if inline not in inline_allowed and not re.fullmatch(r"[0-9a-f]{40}", inline):
                failures.append(f"{label}: inline code is not a reviewed identifier or help command")
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
        # These documents deliberately offer a small set of reviewed commands.
        # Decode shell quoting before deciding which tokens invoke npx.
        commands = []
        for line in logical.splitlines():
            try:
                lexer = shlex.shlex(line, posix=True, punctuation_chars="();<>|&`")
                lexer.whitespace_split = True
                tokens = list(lexer)
            except ValueError:
                # Prose can contain unmatched apostrophes; it is not a shell command.
                continue
            for index, token in enumerate(tokens):
                if token == "npx":
                    commands.append(tokens[index:])
        if commands != expected_commands[label]:
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
    normalized_guide = shell_lines(guide)
    normalized_block = shell_lines(checksum_block)
    block_start = normalized_guide.find(normalized_block)
    first_install = re.search(r"\bnpx\b", normalized_guide)
    if block_start < 0 or not first_install or first_install.start() != block_start + normalized_block.index(install):
        failures.append("installation guide: download and checksum failures must stop installation")
    if "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md" not in readme:
        failures.append("README.md: missing the packaged installation guide")
    return failures

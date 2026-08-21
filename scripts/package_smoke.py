#!/usr/bin/env python3
"""Install the packed package and exercise init/doctor across repository shapes."""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def run(args: list[str], cwd: pathlib.Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=check, timeout=120)


def main() -> int:
    lab = pathlib.Path(tempfile.mkdtemp(prefix="agent-vigil-package-smoke-"))
    packed = run(["npm", "pack", "--pack-destination", str(lab)], ROOT)
    tarball_name = packed.stdout.strip().splitlines()[-1]
    tarball = lab / tarball_name
    consumer = lab / "consumer"
    consumer.mkdir()
    (consumer / "package.json").write_text('{"private":true}\n')
    run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", str(tarball)], consumer)
    vigil = consumer / "node_modules" / ".bin" / "vigil"
    private_key = lab / "operator.pem"
    public_key = lab / "operator.pub"
    run([str(vigil), "keygen", "--private", str(private_key), "--public", str(public_key)], consumer)

    shapes: list[tuple[str, dict[str, str], list[str], str | None]] = [
        ("plain", {"README.md": "plain\n"}, [], None),
        ("node", {"package.json": '{"scripts":{"test":"node --test"}}\n'}, [], "npm test --silent"),
        ("python", {"pyproject.toml": "[tool.pytest.ini_options]\n"}, [], "python3 -m pytest -q"),
        ("rust", {"Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n"}, [], "cargo test --quiet"),
        ("go", {"go.mod": "module example.test/fixture\n\ngo 1.22\n"}, [], "go test -json ./..."),
        ("maven", {"pom.xml": "<project/>\n"}, [], "mvn test"),
        ("gradle-wrapper", {"gradlew": "#!/bin/sh\n"}, [], "./gradlew test"),
        ("gradle", {"build.gradle.kts": "plugins {}\n"}, [], "gradle test"),
        ("ruby", {"Gemfile": "source 'https://rubygems.org'\n"}, ["spec"], "bundle exec rspec"),
        ("php", {"composer.json": "{}\n"}, [], "./vendor/bin/phpunit"),
        ("dotnet", {"global.json": '{"sdk":{"version":"8.0.100"}}\n'}, [], "dotnet test"),
    ]

    results = []
    for name, files, directories, expected in shapes:
        repo = lab / f"repo-{name}"
        repo.mkdir()
        run(["git", "init", "-q"], repo)
        run(["git", "config", "user.email", "smoke@agent-vigil.invalid"], repo)
        run(["git", "config", "user.name", "Package Smoke"], repo)
        for directory in directories:
            (repo / directory).mkdir(parents=True)
        for rel, content in files.items():
            path = repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            if rel == "gradlew": path.chmod(0o755)
        run(["git", "add", "-A"], repo)
        run(["git", "commit", "-qm", "fixture"], repo)
        initialized = run([str(vigil), "init", "--repo", str(repo)], repo)
        doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo)
        policy = json.loads((repo / ".agent-vigil.json").read_text())
        actual = policy.get("testCommand")
        if actual != expected:
            raise RuntimeError(f"{name}: expected {expected!r}, got {actual!r}")
        workflow = (repo / ".github/workflows/agent-vigil.yml").read_text()
        if "pull_request.base.sha" not in workflow or "policy-ref" not in workflow:
            raise RuntimeError(f"{name}: generated workflow lacks exact-SHA policy anchoring")
        if "0 failure(s)" not in doctor.stdout:
            raise RuntimeError(f"{name}: doctor failed: {doctor.stdout}\n{doctor.stderr}")
        portable_initialized = run([str(vigil), "init", "--portable", "--public-key", str(public_key), "--force", "--repo", str(repo)], repo)
        portable_doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo)
        portable_policy = json.loads((repo / ".agent-vigil.json").read_text())
        portable_workflow = (repo / ".github/workflows/agent-vigil.yml").read_text()
        if portable_policy.get("portableReceipt") != ".agent-vigil/receipt.json" or len(portable_policy.get("trustedSignerKeyIds", [])) != 1:
            raise RuntimeError(f"{name}: portable policy was not pinned")
        if "receipt: .agent-vigil/receipt.json" not in portable_workflow or "transcript:" in portable_workflow:
            raise RuntimeError(f"{name}: portable workflow is incorrect")
        if "0 failure(s)" not in portable_doctor.stdout:
            raise RuntimeError(f"{name}: portable doctor failed: {portable_doctor.stdout}\n{portable_doctor.stderr}")
        results.append({
            "shape": name,
            "testCommand": actual,
            "standardInitExit": initialized.returncode,
            "standardDoctorExit": doctor.returncode,
            "portableInitExit": portable_initialized.returncode,
            "portableDoctorExit": portable_doctor.returncode,
        })

    print(json.dumps({"packed": tarball.name, "repositories": len(results), "setupFlows": len(results) * 2, "passed": len(results), "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

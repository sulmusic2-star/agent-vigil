#!/usr/bin/env python3
"""Create disposable real repositories and test Agent Vigil against their toolchains."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "dist" / "cli.js"
ACTION_SHA = "0123456789abcdef0123456789abcdef01234567"


def run(args: list[str], cwd: pathlib.Path, *, check: bool = True, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=check, timeout=timeout)


def init_repo(root: pathlib.Path, name: str) -> pathlib.Path:
    repo = root / name
    repo.mkdir()
    run(["git", "init", "-q"], repo)
    run(["git", "config", "user.email", "lab@agent-vigil.invalid"], repo)
    run(["git", "config", "user.name", "Agent Vigil Lab"], repo)
    return repo


def commit(repo: pathlib.Path, message: str) -> None:
    run(["git", "add", "-A"], repo)
    run(["git", "commit", "-qm", message], repo)


def finish(repo: pathlib.Path) -> None:
    (repo / "LAB_CHANGE.md").write_text("verification head\n")
    commit(repo, "head")


def vigil(repo: pathlib.Path, count: int, command: str | None) -> dict[str, object]:
    transcript = repo / f"summary-{count}.md"
    transcript.write_text(f"All {count} tests pass.\n")
    args = [
        "node", str(CLI), str(transcript), "--repo", str(repo),
        "--base", "HEAD~1", "--head", "HEAD", "--strict", "--format", "json",
    ]
    if command:
        args.extend(["--test-cmd", command])
    completed = run(args, repo, check=False)
    try:
        report = json.loads(completed.stdout)
        test_result = next(row for row in report["results"] if row.get("ruleId") in {"tests-pass", "test-count"})
        return {"status": report["summary"]["status"], "evidence": test_result["evidence"], "exit": completed.returncode}
    except Exception:
        return {"status": "ERROR", "evidence": (completed.stderr or completed.stdout)[-500:], "exit": completed.returncode}


def validate_workflow(repo: pathlib.Path) -> None:
    workflow = (repo / ".github" / "workflows" / "agent-vigil.yml").read_text()
    required = [
        "pull_request_target:", "package-manager-cache: false", "persist-credentials: false",
        "isolate-candidate: true", "github.event.pull_request.base.sha",
        "github.event.pull_request.head.sha", f"sulmusic2-star/agent-vigil@{ACTION_SHA}",
    ]
    forbidden = [
        "merge_group:", "github.event.merge_group", "github-token:", "id-token: write",
        "attest: true", "attestations: write", "artifact-metadata: write",
    ]
    if any(item not in workflow for item in required) or any(item in workflow for item in forbidden):
        raise RuntimeError(f"generated workflow violates the v0.20 hosted contract:\n{workflow}")
    if re.search(r"(?m)^  pull_request:\s*$|^\s+[a-z][a-z-]*:\s*write\s*$", workflow):
        raise RuntimeError(f"generated workflow has a candidate-selected trigger or write permission:\n{workflow}")


def hosted_setup(repo: pathlib.Path, expectation: str, local_command: str | None) -> dict[str, object]:
    if expectation not in {"supported", "rejected", "unconfigured"}:
        raise ValueError(f"unknown hosted expectation: {expectation}")
    initialized = run([
        "node", str(CLI), "init", "--action-sha", ACTION_SHA, "--repo", str(repo),
    ], repo, check=False)
    workflow = repo / ".github" / "workflows" / "agent-vigil.yml"
    if expectation == "rejected":
        doctor = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
        expected = f"test command: {local_command}" if local_command else "no test command inferred"
        if initialized.returncode != 2 or workflow.exists() or doctor.returncode != 2 or expected not in doctor.stdout:
            raise RuntimeError(f"unsupported hosted shape did not fail closed while preserving local inference: {initialized.stderr}\n{doctor.stdout}\n{doctor.stderr}")
        return {"status": "REJECTED", "initExit": initialized.returncode, "doctorExit": doctor.returncode, "localTestCommand": local_command}
    if expectation == "unconfigured":
        doctor = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
        policy = repo / ".agent-vigil.json"
        try:
            policy_value = json.loads(policy.read_text())
            no_hosted_test_command = isinstance(policy_value, dict) and "testCommand" not in policy_value
        except (OSError, json.JSONDecodeError):
            no_hosted_test_command = False
        if (
            initialized.returncode != 0
            or not workflow.exists()
            or local_command is not None
            or not no_hosted_test_command
            or doctor.returncode != 2
            or "plain repository has no inferred non-Node toolchain" not in doctor.stdout
            or "committed HEAD" not in doctor.stdout
        ):
            raise RuntimeError(f"unconfigured plain hosted shape did not remain fail closed: {initialized.stdout}\n{initialized.stderr}\n{doctor.stdout}\n{doctor.stderr}")
        return {
            "status": "UNCONFIGURED",
            "initExit": initialized.returncode,
            "doctorExit": doctor.returncode,
            "localTestCommand": local_command,
        }
    if initialized.returncode != 0:
        raise RuntimeError(f"supported hosted init failed: {initialized.stdout}\n{initialized.stderr}")
    precommit = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if precommit.returncode != 2 or "committed HEAD" not in precommit.stdout:
        raise RuntimeError(f"pre-commit hosted doctor did not fail closed: {precommit.stdout}\n{precommit.stderr}")
    commit(repo, "hosted controls")
    doctor = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if doctor.returncode != 0 or "0 failure(s)" not in doctor.stdout:
        raise RuntimeError(f"committed hosted doctor did not pass: {doctor.stdout}\n{doctor.stderr}")
    validate_workflow(repo)
    return {"status": "PASS", "initExit": initialized.returncode, "preCommitDoctorExit": precommit.returncode, "doctorExit": doctor.returncode}


def portable_gate(repo: pathlib.Path, name: str, root: pathlib.Path, private_key: pathlib.Path, public_key: pathlib.Path) -> dict[str, object]:
    initialized = run([
        "node", str(CLI), "init", "--portable", "--public-key", str(public_key),
        "--force", "--action-sha", ACTION_SHA, "--repo", str(repo),
    ], repo, check=False)
    if initialized.returncode != 0:
        return {"status": "ERROR", "evidence": initialized.stderr[-500:]}
    precommit = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if precommit.returncode != 2:
        return {"status": "ERROR", "evidence": f"portable doctor passed before commit: {precommit.stdout}"}
    validate_workflow(repo)
    commit(repo, "portable policy")
    missing_receipt = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if missing_receipt.returncode != 2 or "absent from committed HEAD" not in missing_receipt.stdout:
        return {"status": "ERROR", "evidence": f"portable doctor accepted a missing receipt: {missing_receipt.stdout}"}
    base = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    (repo / "PORTABLE_CHANGE.md").write_text("portable gate code head\n")
    commit(repo, "portable code head")
    code_head = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    transcript = root / f"private-{name}.md"
    transcript.write_text("All 3 tests pass.\n")
    receipt = repo / ".agent-vigil" / "receipt.json"
    sealed = run([
        "node", str(CLI), str(transcript), "--repo", str(repo), "--base", base, "--head", code_head,
        "--policy", ".agent-vigil.json", "--policy-ref", base, "--signing-key", str(private_key),
        "--portable-output", ".agent-vigil/receipt.json", "--strict",
    ], repo, check=False)
    if sealed.returncode != 0:
        return {"status": "ERROR", "evidence": (sealed.stderr or sealed.stdout)[-500:]}
    uncommitted_receipt = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if uncommitted_receipt.returncode != 2:
        return {"status": "ERROR", "evidence": f"portable doctor accepted an uncommitted receipt: {uncommitted_receipt.stdout}"}
    run(["git", "add", ".agent-vigil/receipt.json"], repo)
    run(["git", "commit", "-qm", "attach portable receipt"], repo)
    receipt_head = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    committed_doctor = run(["node", str(CLI), "doctor", "--repo", str(repo)], repo, check=False)
    if committed_doctor.returncode != 0 or "0 failure(s)" not in committed_doctor.stdout:
        return {"status": "ERROR", "evidence": f"portable doctor rejected committed controls: {committed_doctor.stdout}"}

    def gate(head: str) -> dict[str, object]:
        completed = run([
            "node", str(CLI), "gate", str(receipt), "--repo", str(repo), "--base", base, "--head", head,
            "--policy", ".agent-vigil.json", "--policy-ref", base, "--format", "json",
        ], repo, check=False)
        try:
            report = json.loads(completed.stdout)
            return {"status": report["summary"]["status"], "exit": completed.returncode}
        except Exception:
            return {"status": "ERROR", "exit": completed.returncode, "evidence": (completed.stderr or completed.stdout)[-500:]}

    accepted = gate(receipt_head)
    (repo / "POST_RECEIPT_CHANGE.md").write_text("must invalidate prior receipt\n")
    commit(repo, "post receipt source change")
    changed_head = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    invalidated = gate(changed_head)
    return {
        "accepted": accepted,
        "postReceiptChange": invalidated,
        "preCommitDoctorExit": precommit.returncode,
        "missingReceiptDoctorExit": missing_receipt.returncode,
        "uncommittedReceiptDoctorExit": uncommitted_receipt.returncode,
        "committedDoctorExit": committed_doctor.returncode,
    }


def node_repo(root: pathlib.Path, name: str, prefix: str = "") -> pathlib.Path:
    repo = init_repo(root, name)
    project = repo / prefix if prefix else repo
    project.mkdir(parents=True, exist_ok=True)
    (project / "package.json").write_text(json.dumps({"scripts": {"test": "node --test test.js"}}))
    (project / "test.js").write_text("const{test}=require('node:test');for(let i=1;i<=3;i++)test('case'+i,()=>{});\n")
    commit(repo, "base")
    finish(repo)
    return repo


def build_cases(root: pathlib.Path) -> list[tuple[str, pathlib.Path, str | None, str, str | None]]:
    cases: list[tuple[str, pathlib.Path, str | None, str, str | None]] = []
    if shutil.which("node") and shutil.which("npm"):
        cases.append(("node-npm", node_repo(root, "node-npm"), None, "supported", "npm test --silent"))
        cases.append(("node-monorepo", node_repo(root, "node-monorepo", "packages/api"), "npm --prefix packages/api test --silent", "rejected", None))
    if shutil.which("node") and shutil.which("pnpm"):
        repo = node_repo(root, "node-pnpm")
        (repo / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        commit(repo, "add pnpm lockfile")
        cases.append(("node-pnpm", repo, "pnpm test --silent", "rejected", "npm test --silent"))
    if shutil.which("python3"):
        probe = run(["python3", "-m", "pytest", "--version"], ROOT, check=False)
        if probe.returncode == 0:
            repo = init_repo(root, "python-pytest")
            (repo / "pyproject.toml").write_text('[tool.pytest.ini_options]\ntestpaths=["tests"]\n')
            (repo / "tests").mkdir()
            (repo / "tests/test_math.py").write_text('import pytest\n@pytest.mark.parametrize("x", [1,2,3])\ndef test_positive(x): assert x > 0\n')
            commit(repo, "base"); finish(repo)
            cases.append(("python-pytest", repo, None, "rejected", "python3 -m pytest -q"))
    if shutil.which("go"):
        repo = init_repo(root, "go")
        (repo / "go.mod").write_text("module example.test/vigilfixture\n\ngo 1.22\n")
        (repo / "math.go").write_text("package fixture\nfunc Add(a,b int) int{return a+b}\n")
        (repo / "math_test.go").write_text('package fixture\nimport "testing"\nfunc TestOne(t *testing.T){if Add(1,1)!=2{t.Fail()}}\nfunc TestTwo(t *testing.T){if Add(2,2)!=4{t.Fail()}}\nfunc TestThree(t *testing.T){if Add(3,3)!=6{t.Fail()}}\n')
        commit(repo, "base"); finish(repo)
        cases.append(("go", repo, None, "rejected", "go test -json ./..."))
    if shutil.which("ruby"):
        repo = init_repo(root, "ruby-minitest")
        (repo / "test_example.rb").write_text("require 'minitest/autorun'\nclass ExampleTest < Minitest::Test\n def test_one; assert_equal 2,1+1; end\n def test_two; assert true; end\n def test_three; refute false; end\nend\n")
        commit(repo, "base"); finish(repo)
        cases.append(("ruby-minitest", repo, "ruby test_example.rb", "unconfigured", None))
    if shutil.which("dotnet"):
        repo = init_repo(root, "dotnet-mstest")
        sdk = run(["dotnet", "--version"], repo).stdout.strip()
        run(["dotnet", "new", "sln", "-n", "Fixture"], repo)
        run(["dotnet", "new", "mstest", "-n", "Tests"], repo)
        run(["dotnet", "sln", "add", "Tests/Tests.csproj"], repo)
        (repo / "global.json").write_text(json.dumps({"sdk": {"version": sdk, "rollForward": "latestPatch"}}))
        (repo / "Tests/UnitTest1.cs").write_text("namespace Tests;\n[TestClass] public class UnitTest1 { [TestMethod] public void One()=>Assert.AreEqual(2,1+1); [TestMethod] public void Two()=>Assert.IsTrue(true); [TestMethod] public void Three()=>Assert.IsFalse(false); }\n")
        commit(repo, "base"); finish(repo)
        cases.append(("dotnet-mstest", repo, None, "rejected", "dotnet test"))
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", help="optional JSON output path")
    args = parser.parse_args()
    if not CLI.exists():
        raise SystemExit("build dist/cli.js first with npm run build")
    with tempfile.TemporaryDirectory(prefix="agent-vigil-ecosystem-lab-") as temporary:
        root = pathlib.Path(temporary)
        private_key = root / "operator.pem"
        public_key = root / "operator.pub"
        run(["node", str(CLI), "keygen", "--private", str(private_key), "--public", str(public_key)], root)
        results = []
        for name, repo, command, hosted_expectation, local_command in build_cases(root):
            started = time.time()
            exact = vigil(repo, 3, command)
            inflated = vigil(repo, 99, command)
            for count in (3, 99):
                (repo / f"summary-{count}.md").unlink(missing_ok=True)
            hosted = hosted_setup(repo, hosted_expectation, local_command)
            hosted_supported = hosted_expectation == "supported"
            portable = portable_gate(repo, name, root, private_key, public_key) if hosted_supported else {"status": "NOT_APPLICABLE"}
            results.append({
                "repo": name,
                "command": command or "auto",
                "hostedSupported": hosted_supported,
                "hostedExpectation": hosted_expectation,
                "exact": exact,
                "inflated": inflated,
                "hosted": hosted,
                "portable": portable,
                "seconds": round(time.time() - started, 2),
            })
        passed = sum(
            row["exact"]["status"] == "PASS"
            and row["inflated"]["status"] == "FAIL"
            and (
                row["hosted"]["status"] == "PASS"
                and row["portable"].get("accepted", {}).get("status") == "PASS"
                and row["portable"].get("postReceiptChange", {}).get("status") == "FAIL"
                if row["hostedSupported"]
                else row["hosted"]["status"] == ("REJECTED" if row["hostedExpectation"] == "rejected" else "UNCONFIGURED")
                and row["portable"]["status"] == "NOT_APPLICABLE"
            )
            for row in results
        )
        report = {"repositories": len(results), "verdicts": len(results) * 3 + 2, "passed": passed, "results": results}
        rendered = json.dumps(report, indent=2)
        print(rendered)
        if args.output:
            pathlib.Path(args.output).write_text(rendered + "\n")
        return 0 if passed == len(results) and results else 1


if __name__ == "__main__":
    raise SystemExit(main())

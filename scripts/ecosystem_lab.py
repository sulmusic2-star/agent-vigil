#!/usr/bin/env python3
"""Create disposable real repositories and test Agent Vigil against their toolchains."""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "dist" / "cli.js"


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


def node_repo(root: pathlib.Path, name: str, prefix: str = "") -> pathlib.Path:
    repo = init_repo(root, name)
    project = repo / prefix if prefix else repo
    project.mkdir(parents=True, exist_ok=True)
    (project / "package.json").write_text(json.dumps({"scripts": {"test": "node --test test.js"}}))
    (project / "test.js").write_text("const{test}=require('node:test');for(let i=1;i<=3;i++)test('case'+i,()=>{});\n")
    commit(repo, "base")
    finish(repo)
    return repo


def build_cases(root: pathlib.Path) -> list[tuple[str, pathlib.Path, str | None]]:
    cases: list[tuple[str, pathlib.Path, str | None]] = []
    if shutil.which("node") and shutil.which("npm"):
        cases.append(("node-npm", node_repo(root, "node-npm"), None))
        cases.append(("node-monorepo", node_repo(root, "node-monorepo", "packages/api"), "npm --prefix packages/api test --silent"))
    if shutil.which("node") and shutil.which("pnpm"):
        repo = node_repo(root, "node-pnpm")
        (repo / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        commit(repo, "add pnpm lockfile")
        cases.append(("node-pnpm", repo, "pnpm test --silent"))
    if shutil.which("python3"):
        probe = run(["python3", "-m", "pytest", "--version"], ROOT, check=False)
        if probe.returncode == 0:
            repo = init_repo(root, "python-pytest")
            (repo / "pyproject.toml").write_text('[tool.pytest.ini_options]\ntestpaths=["tests"]\n')
            (repo / "tests").mkdir()
            (repo / "tests/test_math.py").write_text('import pytest\n@pytest.mark.parametrize("x", [1,2,3])\ndef test_positive(x): assert x > 0\n')
            commit(repo, "base"); finish(repo)
            cases.append(("python-pytest", repo, None))
    if shutil.which("go"):
        repo = init_repo(root, "go")
        (repo / "go.mod").write_text("module example.test/vigilfixture\n\ngo 1.22\n")
        (repo / "math.go").write_text("package fixture\nfunc Add(a,b int) int{return a+b}\n")
        (repo / "math_test.go").write_text('package fixture\nimport "testing"\nfunc TestOne(t *testing.T){if Add(1,1)!=2{t.Fail()}}\nfunc TestTwo(t *testing.T){if Add(2,2)!=4{t.Fail()}}\nfunc TestThree(t *testing.T){if Add(3,3)!=6{t.Fail()}}\n')
        commit(repo, "base"); finish(repo)
        cases.append(("go", repo, None))
    if shutil.which("ruby"):
        repo = init_repo(root, "ruby-minitest")
        (repo / "test_example.rb").write_text("require 'minitest/autorun'\nclass ExampleTest < Minitest::Test\n def test_one; assert_equal 2,1+1; end\n def test_two; assert true; end\n def test_three; refute false; end\nend\n")
        commit(repo, "base"); finish(repo)
        cases.append(("ruby-minitest", repo, "ruby test_example.rb"))
    if shutil.which("dotnet"):
        repo = init_repo(root, "dotnet-mstest")
        sdk = run(["dotnet", "--version"], repo).stdout.strip()
        run(["dotnet", "new", "sln", "-n", "Fixture"], repo)
        run(["dotnet", "new", "mstest", "-n", "Tests"], repo)
        run(["dotnet", "sln", "add", "Tests/Tests.csproj"], repo)
        (repo / "global.json").write_text(json.dumps({"sdk": {"version": sdk, "rollForward": "latestPatch"}}))
        (repo / "Tests/UnitTest1.cs").write_text("namespace Tests;\n[TestClass] public class UnitTest1 { [TestMethod] public void One()=>Assert.AreEqual(2,1+1); [TestMethod] public void Two()=>Assert.IsTrue(true); [TestMethod] public void Three()=>Assert.IsFalse(false); }\n")
        commit(repo, "base"); finish(repo)
        cases.append(("dotnet-mstest", repo, None))
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", help="optional JSON output path")
    args = parser.parse_args()
    if not CLI.exists():
        raise SystemExit("build dist/cli.js first with npm run build")
    root = pathlib.Path(tempfile.mkdtemp(prefix="agent-vigil-ecosystem-lab-"))
    results = []
    for name, repo, command in build_cases(root):
        started = time.time()
        exact = vigil(repo, 3, command)
        inflated = vigil(repo, 99, command)
        results.append({
            "repo": name,
            "command": command or "auto",
            "exact": exact,
            "inflated": inflated,
            "seconds": round(time.time() - started, 2),
        })
    passed = sum(row["exact"]["status"] == "PASS" and row["inflated"]["status"] == "FAIL" for row in results)
    report = {"repositories": len(results), "verdicts": len(results) * 2, "passed": passed, "results": results}
    rendered = json.dumps(report, indent=2)
    print(rendered)
    if args.output:
        pathlib.Path(args.output).write_text(rendered + "\n")
    return 0 if passed == len(results) and results else 1


if __name__ == "__main__":
    raise SystemExit(main())

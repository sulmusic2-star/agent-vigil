#!/usr/bin/env python3
"""Freeze constructed comparisons, then execute both tools. No outside adoption."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
GOOD = "exports.add = (a, b) => a + b;\n"
BAD = "exports.add = (a, b) => a - b;\n"
CONTRACT = {"version": 1, "files": ["math.cjs"], "cases": [
    {"id": "positive", "module": "math.cjs", "export": "add", "args": [2, 3], "expect": 5},
    {"id": "opposites", "module": "math.cjs", "export": "add", "args": [-2, 2], "expect": 0},
]}
# Outcomes are fixed before scoring. These are constructed cases, not real
# maintainer incidents. An intentional change is held until separately approved.
CASES = [
    {"id": "unchanged", "source": GOOD, "expected": "PASS"},
    {"id": "helper-refactor", "source": "function sum(a,b){return a+b;} exports.add=sum;\n", "expected": "PASS"},
    {"id": "rewritten-tests", "source": BAD, "test": "const assert=require('node:assert/strict'); const {add}=require('./math.cjs'); assert.equal(add(2,3),-1); assert.equal(add(-2,2),-4);", "expected": "FAIL"},
    {"id": "self-comparing-tests", "source": BAD, "test": "const assert=require('node:assert/strict'); const {add}=require('./math.cjs'); const x=add(2,3); assert.equal(x,x);", "expected": "FAIL"},
    {"id": "empty-tests-correct-code", "source": GOOD, "test": "// intentionally empty ordinary test\n", "expected": "PASS"},
    {"id": "ordinary-regression", "source": BAD, "expected": "FAIL"},
    {"id": "intentional-api-change", "source": BAD, "expected": "FAIL", "note": "Expected hold, not a bug claim. Request separate contract review."},
    {"id": "approved-new-baseline", "baseline": BAD, "source": BAD, "baseExpect": [-1, -4], "expected": "PASS", "note": "Separate approval is assumed by the fixture, not performed or authenticated by the CLI."},
    {"id": "changed-contract", "source": BAD, "headExpect": [-1, -4], "expected": "NOT CHECKED"},
    {"id": "unhealthy-baseline", "baseline": BAD, "source": GOOD, "expected": "NOT CHECKED"},
    {"id": "missing-export", "source": "exports.other=()=>5;", "expected": "NOT CHECKED"},
    {"id": "missing-dependency", "source": "require('missing-dependency');" + GOOD, "expected": "NOT CHECKED"},
    {"id": "exit-zero-without-answer", "source": "process.exit(0);", "expected": "NOT CHECKED"},
    {"id": "forged-test-summary", "source": "console.log('# tests 999\\n# pass 999');process.exit(0);", "expected": "NOT CHECKED"},
    {"id": "patched-assertions", "source": "require('node:assert/strict').equal=()=>{};" + BAD, "expected": "FAIL"},
    {"id": "symlink-module", "symlink": True, "source": GOOD, "expected": "NOT CHECKED"},
    {"id": "source-working-tree-dirty", "source": GOOD, "dirty": BAD, "expected": "PASS"},
    {"id": "contract-working-tree-dirty", "source": BAD, "dirtyContract": True, "expected": "FAIL"},
    {"id": "container-boundary", "source": "const fs=require('node:fs');const os=require('node:os');exports.add=(a,b)=>{if(process.getuid()!==65534||process.env.VIGIL_LAB_SECRET||fs.existsSync('/work/.git')||fs.existsSync('/work/.vigil-regressions.json')||fs.existsSync('/work/unlisted-secret.txt')||fs.existsSync('/var/run/docker.sock')||Object.values(os.networkInterfaces()).flat().some(i=>!i.internal))throw Error('boundary');let denied=false;try{fs.writeFileSync('/work/math.cjs','oops')}catch{denied=true}if(!denied)throw Error('writable');return a+b;};", "expected": "PASS"},
    {"id": "infinite-loop", "source": "exports.add=()=>{while(true){}};", "expected": "NOT CHECKED"},
]

def git(repo, *args):
    return subprocess.check_output(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args], cwd=repo, text=True).strip()

def commit(repo, label):
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=Regression lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", label)
    return git(repo, "rev-parse", "HEAD")

def prepare(out):
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    template = out / "empty-template"
    template.mkdir()
    for spec in CASES:
        repo = out / spec["id"]
        repo.mkdir()
        git(repo, "init", "-q", "--template=" + str(template))
        contract = json.loads(json.dumps(CONTRACT))
        for case, expected in zip(contract["cases"], spec.get("baseExpect", [5, 0])):
            case["expect"] = expected
        (repo / ".vigil-regressions.json").write_text(json.dumps(contract, indent=2) + "\n")
        (repo / "math.cjs").write_text(spec.get("baseline", GOOD))
        (repo / "ordinary.test.cjs").write_text("const a=require('node:assert/strict');const {add}=require('./math.cjs');a.equal(add(2,3),5);a.equal(add(-2,2),0);\n")
        (repo / "unlisted-secret.txt").write_text("DUMMY SENTINEL, NOT A REAL SECRET\n")
        base = commit(repo, "approved baseline (constructed)")
        if spec.get("symlink"):
            (repo / "math.cjs").unlink()
            (repo / "math.cjs").symlink_to("/etc/passwd")
        else:
            (repo / "math.cjs").write_text(spec["source"])
        if "test" in spec:
            (repo / "ordinary.test.cjs").write_text(spec["test"])
        if "headExpect" in spec:
            for case, expected in zip(contract["cases"], spec["headExpect"]):
                case["expect"] = expected
            (repo / ".vigil-regressions.json").write_text(json.dumps(contract, indent=2) + "\n")
        head = commit(repo, spec["id"])
        if "dirty" in spec:
            (repo / "math.cjs").write_text(spec["dirty"])
        if spec.get("dirtyContract"):
            contract["cases"][0]["expect"] = -1
            (repo / ".vigil-regressions.json").write_text(json.dumps(contract))
        rows.append({**spec, "repo": str(repo), "base": base, "head": head})
    protocol = {"kind": "constructed-internal-only", "cases": rows, "rules": "Two repeats on each revision. FAIL is a consistent protected-value mismatch. Missing/unreliable evidence holds with NOT CHECKED. Equivalent CI uses its own controller, not Vigil.", "preparedAt": time.time()}
    data = json.dumps(protocol, indent=2) + "\n"
    (out / "PROTOCOL.json").write_text(data)
    (out / "PROTOCOL.sha256").write_text(hashlib.sha256(data.encode()).hexdigest() + "\n")

def run(out):
    data = (out / "PROTOCOL.json").read_bytes()
    assert hashlib.sha256(data).hexdigest() == (out / "PROTOCOL.sha256").read_text().strip()
    rows = []
    for case in json.loads(data)["cases"]:
        row = {"id": case["id"], "expected": case["expected"], "base": case["base"], "head": case["head"]}
        for tool in ["vigil", "independent-ci"]:
            command = ["node", str(ROOT / "dist/cli.js"), "regression", "check", "--repo", case["repo"], "--base", case["base"], "--head", case["head"], "--json"] if tool == "vigil" else ["node", str(ROOT / "examples/protected-regressions/plain-ci.mjs"), case["repo"], case["base"], case["head"]]
            start = time.perf_counter()
            result = subprocess.run(command, capture_output=True, text=True, timeout=180)
            (out / f"{case['id']}-{tool}.stdout.json").write_text(result.stdout)
            (out / f"{case['id']}-{tool}.stderr.txt").write_text(result.stderr)
            receipt = json.loads(result.stdout)
            row[tool] = {"verdict": receipt["verdict"], "exit": result.returncode, "machineSeconds": time.perf_counter() - start}
        rows.append(row)
        (out / "RESULTS.json").write_text(json.dumps({"rows": rows, "complete": len(rows) == len(CASES), "cliSha256": hashlib.sha256((ROOT / 'dist/cli.js').read_bytes()).hexdigest(), "ciSha256": hashlib.sha256((ROOT / 'examples/protected-regressions/plain-ci.mjs').read_bytes()).hexdigest()}, indent=2))
        print(json.dumps(row), flush=True)
    if any(row[tool]["verdict"] != row["expected"] for row in rows for tool in ["vigil", "independent-ci"]):
        raise SystemExit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "run"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    prepare(args.directory) if args.mode == "prepare" else run(args.directory)

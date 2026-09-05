#!/usr/bin/env python3
"""Install the packed package and exercise the fail-closed hosted setup contract."""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import tempfile

from package_install_smoke import anonymous_package_install

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTION_SHA = "0123456789abcdef0123456789abcdef01234567"


def run(args: list[str], cwd: pathlib.Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=check, timeout=120)


def commit(repo: pathlib.Path, message: str) -> None:
    run(["git", "add", "-A"], repo)
    run(["git", "commit", "-qm", message], repo)


def create_repo(lab: pathlib.Path, name: str, files: dict[str, str]) -> pathlib.Path:
    repo = lab / f"repo-{name}"
    repo.mkdir()
    run(["git", "init", "-q"], repo)
    run(["git", "config", "user.email", "smoke@agent-vigil.invalid"], repo)
    run(["git", "config", "user.name", "Package Smoke"], repo)
    for rel, content in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        if rel == "gradlew":
            path.chmod(0o755)
    commit(repo, "fixture")
    return repo


def require_failed(completed: subprocess.CompletedProcess[str], context: str, fragment: str | None = None) -> None:
    output = f"{completed.stdout}\n{completed.stderr}"
    if completed.returncode != 2 or "0 failure(s)" in completed.stdout:
        raise RuntimeError(f"{context} did not fail closed: {output}")
    if fragment and fragment not in output:
        raise RuntimeError(f"{context} did not report {fragment!r}: {output}")


def require_doctor_pass(completed: subprocess.CompletedProcess[str], context: str) -> None:
    if completed.returncode != 0 or "0 failure(s)" not in completed.stdout:
        raise RuntimeError(f"{context} did not pass: {completed.stdout}\n{completed.stderr}")


def require_workflow_contract(repo: pathlib.Path, *, setup: bool) -> None:
    workflow = (repo / ".github" / "workflows" / "agent-vigil.yml").read_text()
    outcome = (repo / ".github" / "workflows" / "agent-vigil-outcomes.yml").read_text()
    required = [
        "pull_request_target:",
        "types: [opened, synchronize, reopened, edited]",
        "package-manager-cache: false",
        "persist-credentials: false",
        "allow-unsafe-pr-checkout: true",
        "node-version: 22.23.2",
        "isolate-candidate: true",
        "github.event.pull_request.base.sha",
        "github.event.pull_request.head.sha",
        f"sulmusic2-star/agent-vigil@{ACTION_SHA}",
    ]
    if any(item not in workflow for item in required):
        raise RuntimeError(f"generated evidence workflow is missing its v0.21 isolation contract:\n{workflow}")
    if setup != ("candidate-setup-cmd: npm ci --ignore-scripts" in workflow):
        raise RuntimeError(f"generated evidence workflow has the wrong candidate setup contract:\n{workflow}")
    forbidden = [
        "merge_group:",
        "github.event.merge_group",
        "github-token:",
        "id-token: write",
        "attest: true",
        "attestations: write",
        "artifact-metadata: write",
    ]
    if any(item in workflow for item in forbidden) or re.search(r"(?m)^  pull_request:\s*$", workflow):
        raise RuntimeError(f"generated evidence workflow contains an unsupported trigger or privilege:\n{workflow}")
    if re.search(r"(?m)^\s+[a-z][a-z-]*:\s*write\s*$", workflow):
        raise RuntimeError(f"generated evidence workflow grants write permission:\n{workflow}")
    if f"sulmusic2-star/agent-vigil@{ACTION_SHA}" not in outcome:
        raise RuntimeError("outcome workflow does not use the same immutable Agent Vigil runtime")


def standard_setup(
    vigil: pathlib.Path,
    repo: pathlib.Path,
    name: str,
    expected_command: str | None,
    *,
    setup: bool,
) -> dict[str, object]:
    initialized = run([str(vigil), "init", "--action-sha", ACTION_SHA, "--repo", str(repo)], repo, check=False)
    if initialized.returncode != 0:
        raise RuntimeError(f"{name}: supported init failed: {initialized.stdout}\n{initialized.stderr}")
    precommit = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(precommit, f"{name}: pre-commit doctor", "committed HEAD")
    commit(repo, "commit generated hosted controls")
    doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_doctor_pass(doctor, f"{name}: committed doctor")

    policy = json.loads((repo / ".agent-vigil.json").read_text())
    if policy.get("testCommand") != expected_command:
        raise RuntimeError(f"{name}: expected direct hosted command {expected_command!r}, got {policy.get('testCommand')!r}")
    require_workflow_contract(repo, setup=setup)
    return {
        "shape": name,
        "testCommand": expected_command,
        "initExit": initialized.returncode,
        "preCommitDoctorExit": precommit.returncode,
        "committedDoctorExit": doctor.returncode,
    }


def hermetic_setup(vigil: pathlib.Path, repo: pathlib.Path, name: str, command: str) -> dict[str, object]:
    image = "ghcr.io/example/agent-vigil-runner@sha256:" + ("a" * 64)
    initialized = run([
        str(vigil), "init", "--action-sha", ACTION_SHA, "--repo", str(repo),
        "--runner-image", image, "--test-cmd", command,
    ], repo, check=False)
    if initialized.returncode != 0:
        raise RuntimeError(f"{name}: hermetic init failed: {initialized.stdout}\n{initialized.stderr}")
    commit(repo, "commit hermetic hosted controls")
    doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_doctor_pass(doctor, f"{name}: hermetic doctor")
    workflow = (repo / ".github" / "workflows" / "agent-vigil.yml").read_text()
    runner = json.loads((repo / ".agent-vigil-runner.json").read_text())
    policy = json.loads((repo / ".agent-vigil.json").read_text())
    if runner != {"schemaVersion": 1, "image": image, "testCommand": command}:
        raise RuntimeError(f"{name}: hermetic runner file is incorrect: {runner}")
    if policy.get("testCommand") != command or f"candidate-image: {image}" not in workflow:
        raise RuntimeError(f"{name}: hermetic policy or workflow is incorrect")
    return {"shape": name, "testCommand": command, "initExit": initialized.returncode, "committedDoctorExit": doctor.returncode}


def portable_and_authority_setup(
    vigil: pathlib.Path,
    repo: pathlib.Path,
    name: str,
    public_key: pathlib.Path,
    *,
    setup: bool,
) -> dict[str, object]:
    portable = run([
        str(vigil), "init", "--portable", "--public-key", str(public_key),
        "--force", "--action-sha", ACTION_SHA, "--repo", str(repo),
    ], repo, check=False)
    if portable.returncode != 0:
        raise RuntimeError(f"{name}: portable init failed: {portable.stdout}\n{portable.stderr}")
    portable_precommit = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(portable_precommit, f"{name}: portable pre-commit doctor", "committed HEAD")
    portable_policy = json.loads((repo / ".agent-vigil.json").read_text())
    portable_workflow = (repo / ".github" / "workflows" / "agent-vigil.yml").read_text()
    if portable_policy.get("portableReceipt") != ".agent-vigil/receipt.json" or len(portable_policy.get("trustedSignerKeyIds", [])) != 1:
        raise RuntimeError(f"{name}: portable policy was not pinned")
    if "receipt: .agent-vigil/receipt.json" not in portable_workflow or "transcript:" in portable_workflow:
        raise RuntimeError(f"{name}: portable workflow is incorrect")
    require_workflow_contract(repo, setup=setup)
    commit(repo, "commit portable hosted controls")
    portable_missing_receipt = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(portable_missing_receipt, f"{name}: portable doctor without receipt", "absent from committed HEAD")

    authority = run([
        str(vigil), "init", "--profile", "authority", "--force",
        "--action-sha", ACTION_SHA, "--repo", str(repo),
    ], repo, check=False)
    if authority.returncode != 0:
        raise RuntimeError(f"{name}: authority init failed: {authority.stdout}\n{authority.stderr}")
    authority_precommit = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(authority_precommit, f"{name}: authority pre-commit doctor")
    commit(repo, "commit authority placeholder")
    placeholder = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(placeholder, f"{name}: authority placeholder doctor", "replace the generated taskId")
    if "structured tool calls" not in placeholder.stdout:
        raise RuntimeError(f"{name}: authority placeholder did not require structured evidence: {placeholder.stdout}")

    authority_path = repo / ".agent-vigil-authority.json"
    authority_value = json.loads(authority_path.read_text())
    authority_value["taskId"] = f"PACKAGE-SMOKE-{name}"
    authority_value["expiresAt"] = "2099-01-01T00:00:00.000Z"
    authority_path.write_text(json.dumps(authority_value, indent=2) + "\n")
    session_rows = [
        {"type": "session_meta", "payload": {"id": f"package-smoke-{name}"}},
        {"type": "response_item", "payload": {"type": "function_call", "call_id": "status", "name": "exec_command", "arguments": json.dumps({"cmd": "git status --short"})}},
        {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "status", "output": json.dumps({"exit_code": 0, "output": ""})}},
    ]
    (repo / ".agent-vigil" / "session.jsonl").write_text("\n".join(json.dumps(row) for row in session_rows) + "\n")
    authority_uncommitted = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(authority_uncommitted, f"{name}: reviewed but uncommitted authority doctor", "not identical to committed HEAD")
    commit(repo, "commit reviewed authority controls")
    authority_doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_doctor_pass(authority_doctor, f"{name}: reviewed authority doctor")
    authority_workflow = (repo / ".github" / "workflows" / "agent-vigil.yml").read_text()
    if "authority-contract-ref: ${{ github.event.pull_request.base.sha }}" not in authority_workflow:
        raise RuntimeError(f"{name}: authority workflow is not pull-request-base anchored")
    require_workflow_contract(repo, setup=setup)
    return {
        "portableInitExit": portable.returncode,
        "portablePreCommitDoctorExit": portable_precommit.returncode,
        "portableMissingReceiptDoctorExit": portable_missing_receipt.returncode,
        "authorityInitExit": authority.returncode,
        "authorityPreCommitDoctorExit": authority_precommit.returncode,
        "authorityPlaceholderDoctorExit": placeholder.returncode,
        "authorityUncommittedReviewDoctorExit": authority_uncommitted.returncode,
        "authorityDoctorExit": authority_doctor.returncode,
    }


def rejected_setup(
    vigil: pathlib.Path,
    repo: pathlib.Path,
    name: str,
    error_fragment: str,
    local_command: str | None,
) -> dict[str, object]:
    initialized = run([str(vigil), "init", "--action-sha", ACTION_SHA, "--repo", str(repo)], repo, check=False)
    require_failed(initialized, f"{name}: unsupported init", error_fragment)
    if (repo / ".github" / "workflows" / "agent-vigil.yml").exists() or (repo / ".agent-vigil.json").exists():
        raise RuntimeError(f"{name}: rejected init left a partial hosted scaffold")
    doctor = run([str(vigil), "doctor", "--repo", str(repo)], repo, check=False)
    require_failed(doctor, f"{name}: unsupported hosted doctor", "Hosted repository contract")
    expected_local = f"test command: {local_command}" if local_command else "no test command inferred"
    if expected_local not in doctor.stdout:
        raise RuntimeError(f"{name}: local doctor inference was not preserved: {doctor.stdout}\n{doctor.stderr}")
    return {
        "shape": name,
        "initExit": initialized.returncode,
        "doctorExit": doctor.returncode,
        "localTestCommand": local_command,
        "workflowCreated": False,
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="agent-vigil-package-smoke-") as temporary:
        lab = pathlib.Path(temporary)
        packed = run(["npm", "pack", "--pack-destination", str(lab)], ROOT)
        tarball_name = packed.stdout.strip().splitlines()[-1]
        tarball = lab / tarball_name
        anonymous_install = anonymous_package_install(tarball, lab, ACTION_SHA)
        consumer = lab / "consumer"
        consumer.mkdir()
        (consumer / "package.json").write_text('{"private":true}\n')
        run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", str(tarball)], consumer)
        vigil = consumer / "node_modules" / ".bin" / "vigil"
        installed = consumer / "node_modules" / "@sulmusic" / "agent-vigil"
        vector_dir = installed / "test-vectors" / "continuity-staple" / "v1"
        library_check = consumer / "continuity-library-check.mjs"
        library_check.write_text(
            'import { readFileSync } from "node:fs";\n'
            'import { parseContinuityStapleJson, verifyContinuityStaple } from "@sulmusic/agent-vigil/continuity-staple";\n'
            f'const root={json.dumps(str(vector_dir))};\n'
            'const manifest=JSON.parse(readFileSync(`${root}/manifest.json`,"utf8"));\n'
            'const result=verifyContinuityStaple(parseContinuityStapleJson(readFileSync(`${root}/current.staple.json`,"utf8")),{publicKeyPem:readFileSync(`${root}/authority-public.pem`),...manifest.bindings,now:new Date(manifest.times.freshVerification)});\n'
            'if(result.effectiveContinuity!=="CURRENT"||!result.allowsProtectedAction)throw new Error("packed library did not allow the signed CURRENT vector");\n'
            'process.stdout.write(JSON.stringify({status:result.effectiveContinuity,allowed:result.allowsProtectedAction}));\n'
        )
        library_result = json.loads(run(["node", str(library_check)], consumer).stdout)

        continuity_help = run([str(vigil), "continuity", "--help"], consumer)
        required_help = ["continuity init", "continuity import-github", "continuity status", "continuity demo", "continuity install-action"]
        if any(item not in continuity_help.stdout for item in required_help):
            raise RuntimeError(f"packed continuity CLI help is incomplete: {continuity_help.stdout}\n{continuity_help.stderr}")
        continuity_demo = run([str(vigil), "continuity", "demo", "--format", "json"], consumer)
        demo_value = json.loads(continuity_demo.stdout)
        if [step.get("result") for step in demo_value.get("steps", [])] != ["PASS", "CURRENT", "REVOKED", "REVOKED", "CURRENT"]:
            raise RuntimeError(f"packed continuity demonstration is incorrect: {continuity_demo.stdout}\n{continuity_demo.stderr}")
        autopsy_help = run([str(vigil), "autopsy", "--help"], consumer)
        if "vigil autopsy [<transcript.jsonl>]" not in autopsy_help.stdout or "required for EARNED" not in autopsy_help.stdout:
            raise RuntimeError(f"packed autopsy CLI help is incomplete: {autopsy_help.stdout}\n{autopsy_help.stderr}")
        autopsy_transcript = lab / "packed-autopsy.jsonl"
        autopsy_output = lab / "packed-autopsy-output.json"
        autopsy_transcript.write_text("\n".join([
            json.dumps({"type": "system", "conversationId": "12345678-1234-1234-1234-123456789abc"}),
            json.dumps({"type": "assistant", "message": {"content": "private package-smoke prompt"}}),
            json.dumps({"type": "tool_call", "subtype": "started", "call_id": "one", "tool_call": {"shellToolCall": {"args": {"command": "npm test"}}}}),
            json.dumps({"type": "tool_call", "subtype": "completed", "call_id": "one", "tool_call": {"shellToolCall": {"result": "ok"}}}),
        ]) + "\n")
        autopsy_check = run([
            str(vigil), "autopsy", str(autopsy_transcript), "--format", "json", "--output", str(autopsy_output),
        ], consumer, check=False)
        autopsy_record = json.loads(autopsy_output.read_text())
        if autopsy_check.returncode != 2 or autopsy_record.get("decision") != "NOT_CHECKED":
            raise RuntimeError(f"packed autopsy did not fail closed without evidence: {autopsy_check.stdout}\n{autopsy_check.stderr}")
        if autopsy_record.get("privacy") != {
            "localOnly": True, "transcriptIncluded": False, "promptIncluded": False, "providerExportIncluded": False
        } or "private package-smoke prompt" in autopsy_output.read_text():
            raise RuntimeError("packed autopsy disclosed transcript content or emitted the wrong privacy contract")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node executable is unavailable for the packed guard compatibility check")
        protected_help = run([str(vigil), "run", "--help"], consumer)
        if "vigil run --time-limit <duration>" not in protected_help.stdout or "--budget-usd refuses" not in protected_help.stdout:
            raise RuntimeError(f"packed protected-run CLI help is incomplete: {protected_help.stdout}\n{protected_help.stderr}")
        protected_output = lab / "packed-protected-run.json"
        protected_check = run([
            str(vigil), "run", "--time-limit", "2s", "--output", str(protected_output),
            "--", node, "-e", "process.exit(0)", "private package-smoke argument",
        ], consumer)
        protected_record = json.loads(protected_output.read_text())
        if protected_check.returncode != 0 or protected_record.get("state") != "EXITED":
            raise RuntimeError(f"packed protected run did not preserve a normal exit: {protected_check.stdout}\n{protected_check.stderr}")
        if protected_record.get("outcome") != {"commandCompletion": "OBSERVED_ONLY", "economicResult": "NOT_CHECKED"}:
            raise RuntimeError("packed protected run overstated its observed outcome")
        if protected_record.get("process", {}).get("processGroupTerminationConfirmed") is not True:
            raise RuntimeError("packed protected run did not confirm the ordinary process-group boundary")
        if "private package-smoke argument" in protected_output.read_text() or protected_output.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError("packed protected run disclosed argv or wrote a non-private receipt")
        telemetry_output = lab / "packed-protected-telemetry.json"
        telemetry_capture = lab / "packed-protected-telemetry.jsonl"
        telemetry_rows = "\n".join([
            json.dumps({"type": "session_meta", "payload": {"id": "run"}}),
            json.dumps({"type": "response_item", "payload": {
                "type": "function_call", "call_id": "one", "name": "exec_command", "arguments": "{}"
            }}),
        ]) + "\n"
        telemetry_check = run([
            str(vigil), "run", "--time-limit", "2s", "--max-tool-calls", "0",
            "--capture-jsonl", str(telemetry_capture), "--output", str(telemetry_output),
            "--", node, "-e", f"process.stdout.write({json.dumps(telemetry_rows)})",
        ], consumer, check=False)
        telemetry_record = json.loads(telemetry_output.read_text())
        if telemetry_check.returncode != 124 or telemetry_record.get("stop", {}).get("code") != "TOOL_CALL_LIMIT":
            raise RuntimeError(f"packed protected run did not execute its telemetry worker: {telemetry_check.stdout}\n{telemetry_check.stderr}")
        if telemetry_record.get("telemetry", {}).get("toolCalls") != 1 or not telemetry_capture.exists():
            raise RuntimeError("packed protected run telemetry worker omitted its bounded observation or capture")
        stopped_output = lab / "packed-protected-stop.json"
        stopped_check = run([
            str(vigil), "run", "--time-limit", "250ms", "--termination-grace", "100ms",
            "--output", str(stopped_output), "--", node, "-e",
            "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        ], consumer, check=False)
        stopped_record = json.loads(stopped_output.read_text())
        if stopped_check.returncode != 124 or stopped_record.get("state") != "STOPPED" or stopped_record.get("stop", {}).get("code") != "TIME_LIMIT":
            raise RuntimeError(f"packed protected run did not stop at its wall limit: {stopped_check.stdout}\n{stopped_check.stderr}")
        if stopped_record.get("process", {}).get("killSent") is not True or stopped_record.get("process", {}).get("processGroupTerminationConfirmed") is not True:
            raise RuntimeError("packed protected run did not escalate and confirm process-group termination")
        guard_script = lab / "guard-control.mjs"
        guard_args = lab / "guard-args.json"
        guard_policy = lab / "guard-policy.json"
        guard_configuration = lab / "guard-configuration.json"
        guard_output = lab / "guard-compatibility.json"
        guard_script.write_text(
            'import { readFileSync } from "node:fs";\n'
            'const data=JSON.parse(readFileSync(0,"utf8"));\n'
            'const deny=data.tool_input.command.includes("PROCESS_CONFORMANCE_DENY");\n'
            'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:deny?"deny":"allow"}}));\n'
        )
        guard_args.write_text(json.dumps([str(guard_script)]))
        guard_policy.write_text('{"deny":"PROCESS_CONFORMANCE_DENY"}\n')
        guard_configuration.write_text('{"event":"PreToolUse"}\n')
        guard_check = run([
            str(vigil), "guard-compat", "--host", "codex", "--host-version", "package-fixture",
            "--host-executable", node, "--control-name", "package fixture", "--control-version", "1",
            "--control-executable", node, "--control-artifact", str(guard_script),
            "--control-args", str(guard_args), "--policy", str(guard_policy),
            "--configuration", str(guard_configuration), "--format", "json", "--output", str(guard_output),
        ], consumer)
        guard_receipt = json.loads(guard_output.read_text())
        if guard_receipt.get("status") != "PASS" or guard_receipt.get("deployment") != {
            "state": "HOLD", "reasonCodes": ["LIVE_HOST_ROUTE_NOT_PROVEN"]
        }:
            raise RuntimeError(f"packed guard compatibility check is incorrect: {guard_check.stdout}\n{guard_check.stderr}")

        route_profile = lab / "route-profile"
        route_profile.mkdir(mode=0o700)
        (route_profile / ".agent-vigil-disposable-profile").write_text("agent-vigil disposable host profile v1\n")
        route_host = lab / "route-host.mjs"
        route_output = lab / "live-host-route.json"
        route_host.write_text(
            "#!/usr/bin/env node\n"
            'import { spawnSync } from "node:child_process";\n'
            'import { writeFileSync } from "node:fs";\n'
            "const hook=process.env.AGENT_VIGIL_ROUTE_HOOK_PATH;\n"
            "const allow=process.env.AGENT_VIGIL_ROUTE_ALLOW_COMMAND;\n"
            "const deny=process.env.AGENT_VIGIL_ROUTE_DENY_COMMAND;\n"
            "const invoke=(command,id)=>JSON.parse(spawnSync(process.execPath,[hook],{input:JSON.stringify({session_id:'package-route',turn_id:'package-turn',transcript_path:null,cwd:process.cwd(),hook_event_name:'PreToolUse',model:'fixture',permission_mode:'dontAsk',tool_name:'Bash',tool_input:{command},tool_use_id:id}),encoding:'utf8'}).stdout).hookSpecificOutput.permissionDecision;\n"
            "const token=(command)=>command.match(/'([^']+)' > /)[1];\n"
            "if(invoke(allow,'package-allow')==='allow')writeFileSync(process.env.AGENT_VIGIL_ROUTE_ALLOW_FILE,token(allow)+'\\n');\n"
            "invoke(deny,'package-deny');\n"
            "process.stdout.write(JSON.stringify({result:'ROUTE_DRILL_COMPLETE'}));\n"
        )
        route_host.chmod(0o700)
        route_check = run([
            str(vigil), "guard-route", "--host", "codex", "--host-version", "package-fixture",
            "--host-executable", str(route_host), "--profile-home", str(route_profile),
            "--timeout-ms", "5000", "--format", "json", "--output", str(route_output),
        ], consumer)
        route_receipt = json.loads(route_output.read_text())
        if route_receipt.get("status") != "PASS" or route_receipt.get("summary") != {
            "passed": 2, "total": 2, "routedCalls": 2, "unexpectedCalls": 0
        } or route_receipt.get("deployment", {}).get("state") != "HOLD":
            raise RuntimeError(f"packed live-host route check is incorrect: {route_check.stdout}\n{route_check.stderr}")
        if (route_profile / "hooks.json").exists() or (route_profile / "config.toml").exists():
            raise RuntimeError("packed live-host route check left temporary host configuration behind")
        private_key = lab / "operator.pem"
        public_key = lab / "operator.pub"
        run([str(vigil), "keygen", "--private", str(private_key), "--public", str(public_key)], consumer)

        supported_shapes: list[tuple[str, dict[str, str], str | None, bool]] = [
            ("plain", {"README.md": "plain\n"}, None, False),
            ("node-direct", {
                "package.json": json.dumps({"name": "direct", "scripts": {"test": "node --test test/*.test.js"}}) + "\n",
                "package-lock.json": json.dumps({"name": "direct", "lockfileVersion": 3, "requires": True, "packages": {"": {"name": "direct"}}}) + "\n",
                "test/example.test.js": "import test from 'node:test'; test('control', () => {});\n",
            }, "node --test test/*.test.js", True),
            ("node-override", {
                "package.json": json.dumps({
                    "name": "override",
                    "scripts": {"test": "tsx --test test/*.test.ts"},
                    "agentVigil": {"hostedTestCommand": "node --test test/*.test.js"},
                }) + "\n",
                "test/example.test.js": "import test from 'node:test'; test('control', () => {});\n",
            }, "node --test test/*.test.js", False),
        ]

        unsupported_shapes: list[tuple[str, dict[str, str], str, str | None]] = [
            ("python", {"pyproject.toml": "[tool.pytest.ini_options]\n"}, "bounded direct node --test command", "python3 -m pytest -q"),
            ("rust", {"Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n"}, "bounded direct node --test command", "cargo test --quiet"),
            ("go", {"go.mod": "module example.test/fixture\n\ngo 1.22\n"}, "bounded direct node --test command", "go test -json ./..."),
            ("maven", {"pom.xml": "<project/>\n"}, "bounded direct node --test command", "mvn test"),
            ("gradle-wrapper", {"gradlew": "#!/bin/sh\n"}, "bounded direct node --test command", "./gradlew test"),
            ("gradle", {"build.gradle.kts": "plugins {}\n"}, "bounded direct node --test command", "gradle test"),
            ("ruby", {"Gemfile": "source 'https://rubygems.org'\n", "spec/example_spec.rb": "# fixture\n"}, "bounded direct node --test command", "bundle exec rspec"),
            ("php", {"composer.json": "{}\n"}, "bounded direct node --test command", "./vendor/bin/phpunit"),
            ("dotnet", {"global.json": '{"sdk":{"version":"8.0.100"}}\n'}, "bounded direct node --test command", "dotnet test"),
            ("pnpm", {"package.json": '{"scripts":{"test":"node --test"}}\n', "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"}, "does not support root pnpm-lock.yaml", "npm test --silent"),
            ("yarn", {"package.json": '{"scripts":{"test":"node --test"}}\n', "yarn.lock": "# yarn lock\n"}, "does not support root yarn.lock", "npm test --silent"),
            ("bun", {"package.json": '{"scripts":{"test":"node --test"}}\n', "bun.lock": "{}\n"}, "does not support root bun.lock", "npm test --silent"),
            ("nested-only-npm", {"packages/api/package.json": '{"scripts":{"test":"node --test"}}\n'}, "does not support a nested package.json-only layout", None),
            ("dependencies-without-lock", {"package.json": '{"scripts":{"test":"node --test"},"dependencies":{"left-pad":"1.3.0"}}\n'}, "requires package-lock.json or npm-shrinkwrap.json", "npm test --silent"),
            ("npmrc", {"package.json": '{"scripts":{"test":"node --test"}}\n', ".npmrc": "registry=https://registry.example.invalid/\n"}, "does not support repository .npmrc", "npm test --silent"),
        ]

        supported_results: list[dict[str, object]] = []
        rejected_results: list[dict[str, object]] = []
        control_proof_result: dict[str, object] | None = None
        for name, files, expected_command, setup in supported_shapes:
            repo = create_repo(lab, name, files)
            if name == "plain":
                control_proof_path = lab / "packed-control-proof.json"
                control_proof = run([
                    str(vigil), "prove", "--repo", str(repo), "--base", "HEAD",
                    "--format", "json", "--output", str(control_proof_path),
                ], repo)
                receipt = json.loads(control_proof_path.read_text())
                if receipt.get("status") != "PASS" or receipt.get("summary") != {"passed": 7, "total": 7}:
                    raise RuntimeError(f"packed control proof did not pass: {control_proof.stdout}\n{control_proof.stderr}")
                if str(repo) in control_proof_path.read_text():
                    raise RuntimeError("packed control proof disclosed the source repository path")
                control_proof_result = {"exit": control_proof.returncode, "status": receipt["status"], "challenges": receipt["summary"]["total"]}
            result = standard_setup(vigil, repo, name, expected_command, setup=setup)
            result.update(portable_and_authority_setup(vigil, repo, name, public_key, setup=setup))
            supported_results.append(result)

        hermetic_repo = create_repo(lab, "python-hermetic", {
            "pyproject.toml": "[project]\nname='python-hermetic'\n",
            "test_example.py": "def test_example():\n    assert 2 + 2 == 4\n",
        })
        supported_results.append(hermetic_setup(vigil, hermetic_repo, "python-hermetic", "python3 -m pytest -q"))

        for name, files, error_fragment, local_command in unsupported_shapes:
            repo = create_repo(lab, name, files)
            rejected_results.append(rejected_setup(vigil, repo, name, error_fragment, local_command))

        print(json.dumps({
            "packed": tarball.name,
            "anonymousInstall": anonymous_install,
            "supportedRepositories": len(supported_results),
            "rejectedRepositories": len(rejected_results),
            "controlProof": control_proof_result,
            "continuityHelpExit": continuity_help.returncode,
            "continuityDemoExit": continuity_demo.returncode,
            "continuityLibrary": library_result,
            "autopsyHelpExit": autopsy_help.returncode,
            "autopsyMissingEvidenceExit": autopsy_check.returncode,
            "protectedRunHelpExit": protected_help.returncode,
            "protectedRunExit": protected_check.returncode,
            "protectedRunTelemetryExit": telemetry_check.returncode,
            "protectedRunStopExit": stopped_check.returncode,
            "guardCompatibilityExit": guard_check.returncode,
            "guardDeploymentState": guard_receipt["deployment"]["state"],
            "liveHostRouteExit": route_check.returncode,
            "liveHostRouteStatus": route_receipt["status"],
            "liveHostRouteDeploymentState": route_receipt["deployment"]["state"],
            "supported": supported_results,
            "rejected": rejected_results,
            "passed": len(supported_results) + len(rejected_results),
        }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

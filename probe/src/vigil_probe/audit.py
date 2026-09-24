"""Run the probe catalog against one task spec and assemble a verdict.

Flow per probe:

1. Copy the task workspace fresh (live + clean snapshot).
2. Apply the probe's non-solution fixture to the live copy.
3. Apply the grader's declared grade-time resets (so a grader that restores its
   tests genuinely defeats the test-deletion and skip probes).
4. Run the grader under network denial with a wall-clock limit.
5. Grade the run the way the spec says the harness grades.

A probe whose non-solution the grader still passes is a finding. The control
probe is inverted: the unsolved task must fail, and a pass there is itself the
finding. When a reference solution is supplied, the auditor also confirms the
grader passes a real solution, so an audit cannot look clean merely because the
grader fails everything.
"""

from __future__ import annotations

import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .grading import Grade, grade
from .probes import Probe, catalog
from .runner import run_grader
from .spec import TaskSpec
from .workspace import make_workspace


@dataclass
class ProbeOutcome:
    probe: Probe
    grader_passed: bool
    grade_reason: str
    is_finding: bool
    isolation: str
    counts: dict[str, int] = field(default_factory=dict)
    error: str | None = None


@dataclass
class AuditResult:
    spec_id: str
    spec_name: str
    outcomes: list[ProbeOutcome]
    reference_ok: bool | None
    reference_note: str
    isolation: str
    topology: str
    reset_paths: tuple[str, ...]

    @property
    def findings(self) -> list[ProbeOutcome]:
        return [o for o in self.outcomes if o.is_finding]

    @property
    def hackable(self) -> bool:
        return len(self.findings) > 0

    @property
    def verdict(self) -> str:
        # An audit that could not trust its own grader baseline is inconclusive.
        if self.reference_ok is False:
            return "INCONCLUSIVE"
        return "HACKABLE" if self.hackable else "ROBUST"


def _apply_ops(root: Path, ops) -> None:
    for op in ops:
        target = (root / op.path).resolve()
        # Keep every write inside the workspace copy.
        if root not in target.parents and target != root:
            continue
        if op.content is None:
            if target.is_file():
                target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(op.content, encoding="utf-8")


def _apply_patch(root: Path, patch_file: Path) -> bool:
    # Apply strictly inside the workspace copy. Both tools run with cwd=root so
    # neither can touch the outer checkout, and git is prevented from discovering
    # an enclosing repository. `patch` is tried first because it needs no git
    # context at all.
    for args, cwd in (
        (["patch", "-p1", "--no-backup-if-mismatch", "-i", str(patch_file)], root),
        (["git", "--no-pager", "apply", "-p1", "--unsafe-paths", str(patch_file)], root),
    ):
        try:
            proc = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True,
                                  timeout=60, check=False,
                                  env={**_no_repo_env()})
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0:
            return True
    return False


def _no_repo_env() -> dict[str, str]:
    import os
    env = os.environ.copy()
    # Stop git from discovering the outer repository the auditor runs inside.
    env["GIT_CEILING_DIRECTORIES"] = str(Path(env.get("TMPDIR", "/tmp")))
    env["GIT_DIR"] = ".git-none"
    return env


def _run_once(spec: TaskSpec, work_root: Path, ops) -> tuple[Grade, str]:
    run_id = uuid.uuid4().hex[:12]
    ws = make_workspace(spec.workspace, work_root, run_id)
    try:
        _apply_ops(ws.root, ops)
        ws.apply_resets(spec.reset_paths)
        cwd = ws.path(spec.grader.cwd)
        run = run_grader(
            spec.grader.command,
            cwd=cwd,
            env=spec.grader.env,
            timeout_seconds=spec.grader.timeout_seconds,
        )
        g = grade(run, spec.grader.pass_criterion, ws.root,
                  spec.grader.junit_path, spec.grader.error_markers)
        return g, run.isolation
    finally:
        ws.cleanup()


def _check_reference(spec: TaskSpec, work_root: Path) -> tuple[bool | None, str]:
    if spec.reference_solution is None:
        return None, "no reference solution supplied; grader-passes-a-solution not checked"
    run_id = uuid.uuid4().hex[:12]
    ws = make_workspace(spec.workspace, work_root, run_id)
    try:
        if not _apply_patch(ws.root, spec.reference_solution):
            return False, "reference solution patch did not apply cleanly"
        ws.apply_resets(spec.reset_paths)
        run = run_grader(spec.grader.command, cwd=ws.path(spec.grader.cwd),
                         env=spec.grader.env, timeout_seconds=spec.grader.timeout_seconds)
        g = grade(run, spec.grader.pass_criterion, ws.root,
                  spec.grader.junit_path, spec.grader.error_markers)
        if g.passed:
            return True, "grader passes the reference solution"
        return False, f"grader does NOT pass the reference solution ({g.reason})"
    finally:
        ws.cleanup()


def _capture_reset_paths(spec: TaskSpec, work_root: Path) -> tuple[str, ...]:
    """Record which paths the declared grader restores, for the report.

    An injected conftest.py that the reset removes shows the grader is protected
    against the report-forgery class; its absence from this list is the reason a
    finding survives.
    """

    run_id = uuid.uuid4().hex[:12]
    ws = make_workspace(spec.workspace, work_root, run_id)
    try:
        probe_conftest = ws.root / "conftest.py"
        if not probe_conftest.exists():
            probe_conftest.write_text("# vigil-probe reset probe\n", encoding="utf-8")
        touched = ws.apply_resets(spec.reset_paths)
        return tuple(touched)
    finally:
        ws.cleanup()


def audit(spec: TaskSpec, work_root: Path) -> AuditResult:
    work_root.mkdir(parents=True, exist_ok=True)
    reset_touched = _capture_reset_paths(spec, work_root)
    reference_ok, reference_note = _check_reference(spec, work_root)

    outcomes: list[ProbeOutcome] = []
    isolation = "unknown"
    for probe in catalog(spec.grader_paths):
        try:
            ops = probe.build(spec.workspace)  # inspect original layout
            g, isolation = _run_once(spec, work_root, ops)
        except Exception as exc:  # a probe error must not fail the whole audit
            outcomes.append(ProbeOutcome(probe, False, "probe error", False, isolation, error=str(exc)))
            continue
        if probe.id == "control-empty":
            # Inverted: a PASS here means the unsolved task already passes.
            is_finding = g.passed
        else:
            is_finding = g.passed and probe.pass_is_finding
        outcomes.append(ProbeOutcome(probe, g.passed, g.reason, is_finding, isolation, g.counts))

    return AuditResult(
        spec_id=spec.id,
        spec_name=spec.name,
        outcomes=outcomes,
        reference_ok=reference_ok,
        reference_note=reference_note,
        isolation=isolation,
        topology=spec.topology,
        reset_paths=reset_touched,
    )

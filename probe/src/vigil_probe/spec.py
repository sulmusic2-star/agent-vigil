"""Task-spec model and loader.

A *task spec* tells vigil-probe how one environment task is graded, so the tool
can reproduce the grader faithfully and ask whether it can be satisfied without a
real solution. Specs are plain TOML or JSON so they live next to a task in a
repository and can be reviewed.

Minimal spec (TOML):

    id = "demo-sum"
    name = "Return the sum of a list"
    workspace = "./workspace"          # copied fresh for every run

    # Files the grader restores from its own trusted copy before grading.
    # A hardened grader lists its test files here so a solution cannot edit them.
    reset_paths = ["tests/**", "conftest.py"]

    # Optional: a patch that genuinely solves the task. When present, vigil-probe
    # checks that the grader actually PASSES a real solution (guards against a
    # grader that fails everything, which would hide nothing but audits as safe).
    reference_solution = "./reference.patch"

    [grader]
    command = "python -m pytest -rA -q"
    cwd = "."                          # relative to the workspace copy
    pass_criterion = "pytest_log"      # exit_zero | pytest_log | junit_xml
    timeout_seconds = 120

TOML places every key written after ``[grader]`` inside that table, so
``reset_paths``, ``reference_solution`` and ``grader_paths`` are accepted either
at the top level or inside ``[grader]``. Giving the same key in both places with
different values is an error rather than a silent choice.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:  # Python 3.11+ ships tomllib; fall back to a vendored-free error otherwise.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised only on <3.11
    tomllib = None  # type: ignore[assignment]


PASS_CRITERIA = {"exit_zero", "pytest_log", "junit_xml"}


class SpecError(ValueError):
    """Raised when a task spec is missing required fields or is malformed."""


@dataclass(frozen=True)
class GraderSpec:
    """How a single task is graded."""

    command: str
    cwd: str = "."
    pass_criterion: str = "pytest_log"
    timeout_seconds: int = 300
    junit_path: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    # Log substrings that, if present, mean the grader itself errored (not a
    # legitimate fail) and the result must not be trusted as evidence.
    error_markers: tuple[str, ...] = ()

    def validate(self) -> None:
        if not self.command.strip():
            raise SpecError("grader.command must be a non-empty command string")
        if self.pass_criterion not in PASS_CRITERIA:
            raise SpecError(
                f"grader.pass_criterion must be one of {sorted(PASS_CRITERIA)}, "
                f"got {self.pass_criterion!r}"
            )
        if self.pass_criterion == "junit_xml" and not self.junit_path:
            raise SpecError("grader.junit_path is required when pass_criterion is 'junit_xml'")
        if self.timeout_seconds <= 0:
            raise SpecError("grader.timeout_seconds must be positive")


@dataclass(frozen=True)
class TaskSpec:
    """A gradeable task and the trusted knowledge needed to audit its grader."""

    id: str
    name: str
    workspace: Path
    grader: GraderSpec
    spec_dir: Path
    reset_paths: tuple[str, ...] = ()
    reference_solution: Path | None = None
    # Paths that hold the grader's own logic or hidden tests. If a solution can
    # write these and change the verdict, that is a finding.
    grader_paths: tuple[str, ...] = ()
    notes: str = ""
    # Where grading happens relative to the candidate's workspace. The same
    # non-solution can pass under one topology and fail under another, so the
    # report states which one was declared:
    #   fresh_container   - tests/grader run in a clean image (SWE-bench style)
    #   copy_tests_after  - tests copied in after the candidate finishes (Harbor)
    #   same_sandbox      - grader runs in the candidate's live tree (Inspect)
    topology: str = "same_sandbox"

    def validate(self) -> None:
        if not self.id:
            raise SpecError("id is required")
        if not self.workspace.is_dir():
            raise SpecError(f"workspace directory does not exist: {self.workspace}")
        if self.reference_solution is not None and not self.reference_solution.is_file():
            raise SpecError(f"reference_solution file not found: {self.reference_solution}")
        self.grader.validate()


def _load_raw(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(text)
    if path.suffix in {".toml", ""}:
        if tomllib is None:  # pragma: no cover
            raise SpecError("TOML specs require Python 3.11+ (tomllib). Use a .json spec instead.")
        return tomllib.loads(text)
    raise SpecError(f"unsupported spec extension {path.suffix!r}; use .toml or .json")


def _either_level(raw: dict[str, Any], grader_raw: dict[str, Any], key: str) -> Any:
    """Read ``key`` from the top level or the grader table, rejecting conflicts."""

    top = raw.get(key)
    nested = grader_raw.get(key)
    if top is not None and nested is not None and top != nested:
        raise SpecError(
            f"{key!r} is set both at the top level and inside [grader] with different "
            "values; keep one"
        )
    return top if top is not None else nested


def load_spec(path: str | Path) -> TaskSpec:
    """Load and validate a task spec from a TOML or JSON file."""

    spec_path = Path(path).resolve()
    if not spec_path.is_file():
        raise SpecError(f"spec file not found: {spec_path}")
    raw = _load_raw(spec_path)
    if not isinstance(raw, dict):
        raise SpecError("spec must be a table/object at the top level")

    spec_dir = spec_path.parent
    grader_raw = raw.get("grader")
    if not isinstance(grader_raw, dict):
        raise SpecError("spec must contain a [grader] table")

    grader = GraderSpec(
        command=str(grader_raw.get("command", "")),
        cwd=str(grader_raw.get("cwd", ".")),
        pass_criterion=str(grader_raw.get("pass_criterion", "pytest_log")),
        timeout_seconds=int(grader_raw.get("timeout_seconds", 300)),
        junit_path=(str(grader_raw["junit_path"]) if grader_raw.get("junit_path") else None),
        env={str(k): str(v) for k, v in (grader_raw.get("env") or {}).items()},
        error_markers=tuple(str(m) for m in (grader_raw.get("error_markers") or ())),
    )

    workspace_value = raw.get("workspace", "./workspace")
    workspace = (spec_dir / str(workspace_value)).resolve()

    reference = _either_level(raw, grader_raw, "reference_solution")
    reference_path = (spec_dir / str(reference)).resolve() if reference else None

    spec = TaskSpec(
        id=str(raw.get("id", "")),
        name=str(raw.get("name", raw.get("id", ""))),
        workspace=workspace,
        grader=grader,
        spec_dir=spec_dir,
        reset_paths=tuple(str(p) for p in (_either_level(raw, grader_raw, "reset_paths") or ())),
        reference_solution=reference_path,
        grader_paths=tuple(str(p) for p in (_either_level(raw, grader_raw, "grader_paths") or ())),
        notes=str(raw.get("notes", "")),
        topology=str(raw.get("topology", "same_sandbox")),
    )
    spec.validate()
    return spec

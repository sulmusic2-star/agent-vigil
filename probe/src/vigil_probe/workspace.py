"""Disposable workspace copies and grade-time file resets.

Every probe runs against a fresh copy of the task workspace so fixtures never
leak between runs. The copy also models what a *hardened* grader does: it can
restore a set of trusted paths (its test files, its grader script) from a clean
snapshot immediately before grading, so that anything a candidate wrote to those
paths is discarded. Reproducing that reset is what lets vigil-probe tell a
grader that resets its tests apart from one that does not.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from glob import glob
from pathlib import Path


@dataclass(frozen=True)
class Workspace:
    """A live, disposable copy of a task's files plus a clean snapshot."""

    root: Path
    snapshot: Path

    def path(self, relative: str = ".") -> Path:
        return (self.root / relative).resolve()

    def apply_resets(self, reset_paths: tuple[str, ...]) -> list[str]:
        """Restore trusted paths from the clean snapshot into the live copy.

        For each pattern this both (a) copies the trusted snapshot version over
        the live copy, reverting edits and un-deleting removed files, and (b)
        deletes any live file matching the pattern that the snapshot does not
        contain, so a file the candidate *injected* (an unexpected conftest.py,
        a pytest.ini the task never shipped) is removed. Modelling both halves is
        what lets the auditor tell a grader that truly restores a path from one
        that only reverts edits.

        Returns the workspace-relative paths that were restored or removed.
        """

        touched: list[str] = []
        for pattern in reset_paths:
            for match in sorted(glob(str(self.snapshot / pattern), recursive=True)):
                src = Path(match)
                if src.is_dir():
                    continue
                rel = src.relative_to(self.snapshot)
                dst = self.root / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                touched.append(str(rel).replace("\\", "/"))
            for match in sorted(glob(str(self.root / pattern), recursive=True)):
                live = Path(match)
                if live.is_dir():
                    continue
                rel = live.relative_to(self.root)
                if not (self.snapshot / rel).exists():
                    live.unlink()
                    touched.append(str(rel).replace("\\", "/"))
        return sorted(set(touched))

    def cleanup(self) -> None:
        for target in (self.root, self.snapshot):
            shutil.rmtree(target, ignore_errors=True)


def _copy_tree(source: Path, dest: Path) -> None:
    # dirs_exist_ok keeps this usable on top of a freshly created temp dir.
    shutil.copytree(source, dest, dirs_exist_ok=True, symlinks=True)


def make_workspace(source: Path, work_root: Path, run_id: str) -> Workspace:
    """Create a live copy and an immutable clean snapshot of ``source``."""

    base = work_root / run_id
    live = base / "live"
    snapshot = base / "snapshot"
    live.mkdir(parents=True, exist_ok=True)
    snapshot.mkdir(parents=True, exist_ok=True)
    _copy_tree(source, live)
    _copy_tree(source, snapshot)
    return Workspace(root=live, snapshot=snapshot)

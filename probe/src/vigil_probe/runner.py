"""Run a grader command under network denial and a wall-clock limit.

Two properties matter for a trustworthy audit:

* **No network.** A grader that can reach the internet can be satisfied by a
  candidate that fetches the answer, and a probe that can reach the internet is
  not measuring the grader in isolation. When a Linux user+network namespace is
  available (``unshare -rn``), the grader runs with no usable network
  interface. The runner reports which isolation was actually applied so a report
  never overstates it.
* **Bounded.** Every run has a hard timeout; a grader that hangs is reported as
  an error, never as a pass.

This runner intentionally does not attempt hostile-code containment. Auditing an
untrusted environment's grader should still happen inside a throwaway VM or
container; the namespace here removes ambient network and nothing more.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RunResult:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool
    isolation: str  # "netns" | "none"

    @property
    def combined(self) -> str:
        return f"{self.stdout}\n{self.stderr}"


def _netns_available() -> bool:
    if os.name != "posix" or not shutil.which("unshare"):
        return False
    try:
        proc = subprocess.run(
            ["unshare", "-rn", "true"],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def run_grader(
    command: str,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: int,
    allow_no_isolation: bool = True,
) -> RunResult:
    """Run ``command`` (via the shell) in ``cwd`` with no network if possible."""

    full_env = os.environ.copy()
    full_env.update(env)
    # Keep graders deterministic and offline-leaning even without a namespace.
    full_env.setdefault("PYTHONDONTWRITEBYTECODE", "1")

    use_netns = _netns_available()
    if not use_netns and not allow_no_isolation:
        raise RuntimeError(
            "network isolation was required but 'unshare -rn' is unavailable; "
            "run inside a container/VM that permits it, or pass allow_no_isolation"
        )

    argv = ["/bin/sh", "-c", command]
    if use_netns:
        # New user+network namespace: the child has only a down loopback, so no
        # outbound network. --map-root-user keeps file ownership sane.
        argv = ["unshare", "--user", "--map-root-user", "--net", "/bin/sh", "-c", command]

    try:
        proc = subprocess.run(
            argv,
            cwd=str(cwd),
            env=full_env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return RunResult(
            exit_code=124,
            stdout=exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            stderr=exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or ""),
            timed_out=True,
            isolation="netns" if use_netns else "none",
        )

    return RunResult(
        exit_code=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        timed_out=False,
        isolation="netns" if use_netns else "none",
    )

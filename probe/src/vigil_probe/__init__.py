"""vigil-probe: an independent robustness auditor for AI coding graders.

vigil-probe helps the people who build reinforcement-learning environments and
coding benchmarks answer one defensive question before a model ever trains on a
task:

    Can this task be marked "solved" without actually solving it?

A grader that answers "pass" to a non-solution teaches a model to cheat instead
of to work. vigil-probe applies a fixed battery of *non-solution* fixtures to a
task inside an isolated, network-denied workspace and reports every fixture the
grader still accepts, each with a runnable proof and a concrete fix. It is the
grader-side complement to Agent Vigil's pull-request test-integrity checks.

The tool exists to harden environments, not to defeat them: every finding ships
with the remediation that closes it.
"""

from .version import __version__

__all__ = ["__version__"]

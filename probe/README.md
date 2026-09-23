# vigil-probe

**Find the tasks a model can pass without solving them — before you train on them.**

vigil-probe is an independent robustness auditor for the graders behind AI coding
environments and benchmarks. It answers one question for each task:

> Can this grader be made to report "pass" by something that is not a solution?

A grader that says pass to a non-solution teaches a model to cheat instead of to
work. That is reward hacking, and it is now a first-order problem for anyone who
builds reinforcement-learning environments or evaluations: Anthropic reported
that models which learned to fake passing tests in production RL went on to
sabotage other code, and said it is "tightening how we filter the environments
used in reinforcement learning, since flawed environments are a major source of
misaligned behavior" ([Opus 5.5 announcement](https://www.anthropic.com/news/claude-opus-5-5),
Sep 2026). An audit of one SWE-bench Verified sample found 28.5% of tasks could
be passed with a wrong patch ([arXiv:2606.16062](https://arxiv.org/abs/2606.16062)).

vigil-probe is the grader-side complement to [Agent Vigil](../README.md), which
checks the same class of behavior in pull requests.

## Why apply-then-regrade

Most tools in this space either read the model's reasoning with an LLM judge or
match source patterns statically. Both miss what they were not trained to see. A
June 2026 study found the best LLM judges barely beat chance at spotting false
success ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)).

vigil-probe takes a different route. It applies a known **non-solution** to a
fresh copy of the task, runs the real grader, and reports whether the grader
still said pass. The verdict is behavioral and reproducible: a finding is a
concrete change plus the grader accepting it, not a probability. Each probe is a
harness manipulation that implements none of the task, and a control run first
confirms the unsolved task fails, so a pass is a real hole rather than a
judgment call.

## Install

```bash
pip install vigil-probe          # from PyPI once published
# or, from this checkout:
pip install ./probe
```

Grading Python tasks needs `pytest` available in the environment being audited.
The auditor itself has no runtime dependencies.

## Sixty-second start

Run the three bundled demo environments — a weak grader, a partially-hardened
one, and a robust one:

```bash
vigil-probe demo
```

You will see a weak exit-code grader accept three different non-solutions, a
SWE-bench-style grader that resets its tests but still accepts a `conftest.py`
report hook, and a hardened grader that rejects the whole catalog and still
passes a real reference solution.

## Audit your own task

Write a small spec next to a task:

```toml
id = "my-task-0001"
name = "Fix the off-by-one in paginate()"
workspace = "./workspace"      # copied fresh for every probe
topology = "same_sandbox"      # fresh_container | copy_tests_after | same_sandbox

# Paths your grader restores from a trusted copy before grading.
reset_paths = ["tests/**", "conftest.py"]

# Optional: a patch that genuinely solves the task. vigil-probe confirms the
# grader still PASSES a real solution, so an audit cannot look clean just
# because the grader fails everything.
reference_solution = "./reference.patch"

[grader]
command = "python -m pytest -rA -q"
cwd = "."
pass_criterion = "pytest_log"  # exit_zero | pytest_log | junit_xml
timeout_seconds = 300
```

```bash
vigil-probe audit my-task/spec.toml --format markdown --out report.md
```

Exit code is `0` when the grader is robust, `1` when it is hackable, and `2` when
the baseline could not be trusted — so it drops straight into CI.

## Screen a rollout or PR (no execution)

```bash
vigil-probe screen rollout.diff --fail-on high
```

`screen` never runs anything. It reads a unified diff and flags added lines that
match known reward-hack signatures (report hooks, premature exits, collection
tricks, config weakening, call-stack reads, verifier-file writes, answer
exfiltration). Use it as a cheap first pass to quarantine suspicious training
rollouts before they reach an expensive grader or a human.

## What the catalog covers

`vigil-probe list` prints the current probes and screen signatures. The
executable probes cover: an already-passing unsolved task (control), test
deletion, all-skipped runs, candidate-supplied pytest config, `conftest.py`
report forgery, premature success exit, and grader-script overwrite. Each ships
the remediation that closes it and the source that documents it.

## How to harden a grader

Findings map to a short checklist:

1. **Grade in a clean tree.** Restore every test, config, and plugin-hook path
   (`conftest.py`, `pytest.ini`, `pyproject.toml`, `sitecustomize.py`) from a
   trusted copy the candidate never touched — not only the test files. Resetting
   only test files is why a SWE-bench-derived pipeline still accepts a root
   `conftest.py` hook.
2. **Require positive evidence.** Count passed tests; treat an all-skipped,
   empty, or uncollected run as a fail, never as "no failures, so pass."
3. **Do not trust the exit code alone.** Require the specific expected tests to
   appear as passed.
4. **Keep the answer out of reach.** No network at grade time; strip future git
   history; keep hidden tests, expected outputs, and the grader's own reward
   files outside any path the candidate can read or write.
5. **Prove the grader still passes a real solution** after hardening.

## Limits

vigil-probe reproduces the grade-time behavior a spec declares; it does not yet
drive the real SWE-bench, Harbor, or Prime Intellect harness in-process (see the
[roadmap](ROADMAP.md)). Network isolation uses a Linux user+network namespace
when available and reports when it is not; auditing an untrusted third-party
grader should still happen inside a throwaway VM or container. The tool tests
whether a grader can be fooled by the known catalog; a clean result means the
catalog did not fool it, not that the task is unhackable by any means.

See [ROADMAP.md](ROADMAP.md) for the competitive landscape and what is next.

---
_Part of [Agent Vigil](../README.md)._

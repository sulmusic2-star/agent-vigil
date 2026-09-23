# vigil-probe roadmap and landscape

_Reviewed 2026-09-23._

## Where vigil-probe fits

Tools that look for reward hacking fall into four groups:

| Approach | Examples | Strength | Blind spot |
|---|---|---|---|
| LLM judge or agentic trace review | HUD's detector; BenchJack's agentic stage | Reads intent; finds novel hacks | Misses what it was not prompted to see; judges score near chance on false success ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)) |
| Interpretability probes | Goodfire; Transluce | Cheap per rollout at scale | Needs open weights and activations; cannot audit a closed grader |
| Static pattern matching | EvalGuard; ratctl; BenchJack's static stage | Fast, no execution | Recall bounded by known patterns |
| Apply a known non-solution, then re-grade | vigil-probe; tripwire; the arXiv:2606.16062 method | A finding is a concrete change plus the grader accepting it | Only as broad as its catalog |

vigil-probe keeps its core verdict behavioral. It does not read the model's
reasoning, so it keeps working when reasoning is hidden or stripped, which is
where judge and trace methods degrade.

## Shipped in 0.1.0

- Executable audit: control, test deletion, all-skipped runs, candidate pytest
  config, conftest report forgery, premature success exit, grader overwrite.
- Grade-time reset modelling that both restores and removes paths, so the
  report shows exactly which paths a grader protects.
- Declared grader topology in every report (fresh_container,
  copy_tests_after, same_sandbox).
- Reference-solution check so an audit cannot look clean because the grader
  fails everything.
- Offline `screen` for diffs and training rollouts.
- Text, JSON, and Markdown reports with CI exit codes.

## Next

1. **Native harness adapters.** Drive the real SWE-bench, Harbor/Terminal-Bench,
   Prime Intellect verifiers, R2E-Gym, and Inspect harnesses instead of a
   declared reproduction, and report per-topology verdicts.
2. **Log-parser probes.** Check the parser itself: skipped or expected-failure
   results on required tests, required tests that were never collected, and
   pass text printed outside the region a harness reads.
3. **Leak and reachability scan.** Report what a candidate can read at grade
   time: future git history, hidden tests, expected outputs, the verifier's
   own reward files, and network egress.
4. **Broader catalog.** Import-time injection (sitecustomize, .pth files,
   plugin entry points), standard-library shadowing, call-stack reads, and
   JavaScript, Go, Rust, and Java equivalents of the Python probes.
5. **Fix and re-verify.** For each confirmed hole, emit the grader change that
   closes it, then re-run to show the non-solution now fails and the reference
   solution still passes.
6. **Error accounting.** Flake retries and known-correct controls, so a
   published hackability rate subtracts the harness's own error.
7. **Ground-truth validation.** Measure recall against environments built to
   be hackable, such as the UK AI Security Institute's reward-hacking
   environments and the Terminal Wrench and ImpossibleBench sets.
8. **Reporting for pipelines.** SARIF output, a per-suite hackability score,
   and a public results ledger keyed to benchmark name and version.

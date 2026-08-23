# Counterfactual proof and distribution design

Observed 2026-08-23. This is a technical direction and commercial test, not a
claim of novelty, patentability, adoption, payment, retention, or revenue.

## Decision

Keep Agent Vigil as the product and expose a compact proof comment from its
receipt. `GreenProof` is not a suitable public name: it is already used by a
software product and appears in an active US software-related trademark
application. The wrapper remains an internal concept, not a customer-facing
brand.

Sources: [existing GreenProof product](https://www.get-greenproof.com/),
[software-related trademark record](https://www.trademarkelite.com/trademark/trademark-detail/99234938/GREENPROOF).

Do not build a hosted service that executes arbitrary pull-request code in the
first release. GitHub warns that untrusted pull-request code can compromise
runners and harvest available credentials. The bounded architecture is:

```text
customer GitHub runner -> exact-SHA Agent Vigil receipt
                       -> deterministic proof comment
                       -> one marker-based comment update
                       -> optional receipt verifier
```

The future App needs only the permissions required to read pull-request state
and update one issue comment. It does not need repository contents, workflow,
secret, administration, or code-execution permissions. GitHub Apps begin with
no permissions and should request the minimum required permissions.

Sources:

- [GitHub App permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub compromised-runner guidance](https://docs.github.com/en/actions/concepts/security/compromised-runners)
- [GitHub script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections)

## Why this is not another AI reviewer

Generic review is crowded. CodeRabbit lists paid PR review plans, while
Graphite sells AI review as part of per-user plans. The narrower job here is
not generating more suggestions. It is distinguishing evidence that changed
behavior from evidence that was already green on the base revision.

User reports describe the cost of noisy or inconsistent review. One Copilot
user reported about 21 low-value findings among 24 comments over repeated
review rounds. Another reported the same incorrect suggestion recurring after
it had been explained and resolved. These are practitioner reports, not
prevalence estimates, but they support a one-comment, high-specificity design.

Sources:

- [Copilot repeated review loop report](https://github.com/orgs/community/discussions/189767)
- [Copilot repeated incorrect suggestion report](https://github.com/orgs/community/discussions/190754)
- [CodeRabbit plans](https://docs.coderabbit.ai/management/plans)
- [Graphite pricing](https://www.graphite.com/pricing)

## Current deterministic evidence

For changed test artifact `t`, exact base source `B`, exact candidate source
`C`, and a disclosed environment `e`, define the observed result:

```text
R(c, t, e) in {PASS, FAIL, INCOMPLETE}
```

The current differential check earns a categorical result only when:

```text
R(C, t_candidate, e) = PASS
R(B, t_candidate, e) = FAIL
```

The candidate test artifact is overlaid on the base source in an isolated Git
worktree. A pass on both revisions contradicts the claim that the changed test
distinguishes the fix. Setup errors, timeouts, missing tests, and incomplete
execution remain `INCONCLUSIVE`. One deterministic trial is evidence for that
exact environment; it is not a probability estimate.

SpecBench independently motivates this boundary: it evaluates visible versus
hidden compositional tests and reports that reward-hacking gaps increase with
task length. Its measurements do not establish Agent Vigil's accuracy.

Source: [SpecBench](https://arxiv.org/abs/2605.21384)

## Sequential extension for flaky tests

The next research implementation should repeat paired base and candidate runs
under recorded environment identities. For test `i` and trial `k`:

```text
X+_ik = 1 when R(C, t_i, e_k) = PASS, otherwise 0
X-_ik = 1 when R(B, t_i, e_k) = PASS, otherwise 0
```

For either Bernoulli stream with `S_n` passes in `n` trials, a beta-binomial
mixture likelihood ratio can define an anytime-valid confidence sequence:

```text
M_n(p) = B(S_n + a, n - S_n + b)
         / (B(a, b) p^S_n (1-p)^(n-S_n))

C_n(alpha) = { p in (0,1) : M_n(p) < 1/alpha }
```

Let `[L+_i,U+_i]` and `[L-_i,U-_i]` be the resulting intervals. A configurable
high-confidence rule may call a flaky test discriminating only when:

```text
L+_i >= tau_candidate  and  U-_i <= tau_base
```

The thresholds, prior parameters, environment schedule, stopping rule, and all
trials must be receipt-bound. For `m` simultaneously surfaced tests, allocate
the error budget conservatively across `2m` streams, for example
`alpha_stream = alpha_family/(2m)`. Fixed-horizon research may compare Holm's
procedure, but the product must not mix fixed-horizon p-values with optional
stopping. Insufficient runs return `INCONCLUSIVE` rather than a point estimate.

Anytime-valid methods support monitoring and data-dependent stopping, while
flaky-test research shows that a small number of reruns can badly understate
flakiness. These sources justify evaluation; they do not select production
thresholds for us.

Sources:

- [Anytime-valid confidence sequences in production experimentation](https://arxiv.org/abs/2302.10108)
- [Empirical study of flaky Python tests](https://arxiv.org/abs/2101.09077)

## Commit-relevant mutation evidence

Counterfactual base failure shows necessity for the changed test artifact, but
not adequacy for all affected behavior. A second evidence channel can select
mutants connected to the changed code and its dependency graph. For reviewed,
non-equivalent commit-relevant mutants `m`:

```text
w_m = P(relevant to change | delta, graph)
      * P(operator resembles a real fault | language, operator)
      * (1 - P(equivalent mutant | context))

K_delta = sum_m w_m * 1[test kills m] / sum_m w_m
```

`K_delta` is mutation sensitivity, not correctness probability. Every model or
heuristic used in a weight must be versioned and calibrated against a retained
corpus. Unknown equivalence or missing execution lowers confidence or produces
`INCONCLUSIVE`; it must not silently increase the score.

Commit-relevant mutant research defines mutation evidence tailored to a
specific commit. Google's production work supports changed-code selection and
filtering because unhelpful mutation findings impose review cost.

Sources:

- [Commit-relevant mutants](https://link.springer.com/article/10.1007/s10664-022-10138-1)
- [Practical mutation testing at scale](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/)
- [Long-term effects of mutation testing](https://research.google/pubs/long-term-effects-of-mutation-testing/)

## No deceptive proof score

The product should retain an evidence vector rather than collapse unrelated
controls into one impressive-looking number:

```text
E = (counterfactual discrimination,
     test-integrity status,
     mutation sensitivity,
     authority-plan status,
     provenance and signature status)
```

A scalar can hide a blocking contradiction behind unrelated passes. Merge
policy is therefore lexicographic and fail-closed: invalid provenance,
contradiction, or required uncertainty dominates any positive evidence.

The equations are public and auditable. Secrecy or complexity is not the moat.
The defensible assets would be a cross-vendor normalizer corpus, calibrated
mutation/operator history, low-false-positive regression fixtures, accepted
external catches, retained required checks, and trusted-policy integrations.

## Product and commercial gates

Ship the deterministic receipt comment before a hosted dashboard. Surface one
comment per pull request and update it by marker. Do not expose an unlocated
finding: file and line detail waits for a structured, receipt-bound location
schema.

The day-30 decision remains:

- 10 externally owned repository installations;
- 3 maintainer-accepted material catches;
- 3 required checks retained for 30 days;
- 2 written-only paid pilots;
- zero confirmed false-positive blocking findings in the pilot set.

If installation does not convert to active evidence, comments are not retained,
or maintainers reject the signal quality, stop the wrapper experiment. A badge
or screenshot is distribution only after real users choose to share it.

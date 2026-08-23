# Authority Plan validation record

Observed 2026-08-23 in the isolated local worktree
`agent-vigil-authority-plan.nosync` on branch `codex/authority-plan-v1`.
Baseline commit: `79844663387cc6d45d8fee19f376d30ba263f302`.

Status: local, uncommitted candidate. Not pushed, published, installed in an
external repository, paid for, or generating revenue.

## Public-revision corpus

The final corpus contains 100 immutable natural revision pairs from 70 public
repositories, capped at two pairs per repository:

| Platform | Pairs |
|---|---:|
| MCP | 33 |
| Claude Code | 33 |
| Codex | 34 |

Natural decisions are 15 `PASS`, 75 `BLOCK`, and 10 `HOLD`. Every natural case
is labeled `UNREVIEWED_NATURAL_CHANGE`; these counts are execution coverage,
not detection accuracy or false-positive measurements.

Each real head configuration also received one known high-risk planted
expansion. Expected blocks: 100. Observed blocks: 100. Misses: 0. With only 100
zero-miss planted cases, the approximate one-sided 95% binomial upper bound on
the miss probability is still about 2.95%.

The machine-readable ledger is
[authority-revision-corpus-v1.json](authority-revision-corpus-v1.json). It
retains repository, path, exact commits, source URL, content hashes, and
decisions. Configuration bytes were processed in temporary repositories and
discarded; secret-looking samples were excluded.

## Defects exposed and fixed

Manual review of a stratified natural sample exposed five implementation
defects before release:

1. Claude Code `enabledPlugins` changes were not represented.
2. Claude hook matcher changes could pass because only handler identity was
   compared.
3. Removing an MCP server could falsely report expansion when child deny-list
   atoms disappeared with the server.
4. JSON files with a UTF-8 byte-order mark produced a false parse hold.
5. Claude extra roots were read from a legacy top-level location instead of the
   documented `permissions.additionalDirectories` location.

All five have regression tests. Current MCP authentication, environment-header,
environment-reference, OAuth-resource, and remote-execution fields are now
normalized. Evolving Codex app, subagent, plugin, skill, tool, auto-review, and
computer-use sections fail closed with `HOLD` pending precise semantics.

## Security and reproducibility

- Exact Git objects are read with fixed supported paths; the dirty worktree is
  not trusted as revision evidence.
- Config size is capped at 1 MiB, object depth at 32, and traversed nodes at
  25,000.
- Recognized secret-bearing values are omitted, control and bidirectional
  formatting characters are neutralized, and output is written atomically with
  owner-only permissions.
- Git is invoked with argument arrays and exact paths rather than a shell.
- One build initially failed because the host had only 114 MiB free. Disposable
  Agent Vigil temporary clones and caches were removed, increasing free space
  to 1.9 GiB; no repositories or durable evidence were removed.

## External proof gate

| Evidence | Required | Current |
|---|---:|---:|
| Externally owned repository installations | 10 | 0 |
| Maintainer-accepted catches | 3 | 0 |
| Required checks retained for 30 days | 3 | 0 |
| Written-only paid pilots | 2 | 0 |

The five fixed defects above are internal corpus findings. They do not count as
maintainer-accepted catches. Green local tests do not change any external
count.

## Final local verification

| Check | Result |
|---|---|
| Typecheck, production bundle, standard tests, smoke demo | PASS |
| Standard test run | 406 passed, 5 opt-in Docker tests skipped, 0 failed |
| Digest-pinned Docker test run | 411 passed, 0 skipped, 0 failed |
| Coverage | 93.76% lines, 80.83% branches, 96.44% functions |
| Public revision corpus | 100 pairs, 100/100 planted blocks, 0 planted misses |
| Package smoke | 11 repository shapes, 33 setup flows, all passed |
| Failure-pattern corpus | 20/20 expectations matched |
| Runtime dependency audit | 0 known vulnerabilities |
| Full dependency audit | 0 known vulnerabilities |
| Public-surface gate and self-test | PASS |

The Docker run used
`node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2`.
These are local technical results. They do not prove security, runtime effective
authority, external usefulness, customer retention, payment, or revenue.

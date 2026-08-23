# Changelog

## Unreleased

- Add exact APM, Vercel Skills v3, and Agent Plugins 1.0 update plans that
  require behavioral preflight whenever manager-controlled state changes.
- Add `vigil upgrade preflight`, one fail-closed automatic APM path from exact
  old/new lockfiles through credential-free public GitHub codeload acquisition,
  OpenAPM `tree_sha256` verification, bounded link-free materialization, the
  existing contained check, and verified temporary-session removal. It never
  invokes an installer or lifecycle script; unsupported sources return `HOLD`.
- Add a private `agent-vigil-apm-preflight/v1` wrapper that binds the plan,
  selected row, exact archive and file commitments, bounded manifest evidence,
  independently recomputed target/capability snapshots, nested Upgrade Guard
  receipt, and restoration outcome.
- Add a base-selected Action verifier that binds exact Git objects, rejects
  harness changes, isolates ambient Bash/Node/Git/Docker state, and verifies
  receipt semantics plus the exact exit-to-verdict mapping before exposing an
  output.
- Add privacy-minimized signed compatibility entries, broken-to-restored
  resolution records, static registry/API/badge output, and maintainer evidence.
- Add a disabled-by-default Cloudflare Worker/D1 proof-network service with
  registered publisher keys, moderation, searchable public proof pages/API,
  opt-in anonymous lifecycle events explicitly excluded from demand gates, and
  a frozen append-only first-100 problem-frequency ledger.
- Add a local-only, undeployed Team control-plane implementation with private
  policy/history/gates/exceptions, RBAC, entitlement and revenue ledgers,
  GitHub App installation reconciliation, and separately permissioned Stripe
  executor and read-only reconciliation adapters. Provider configuration is
  intentionally invalid or disabled, and no provider is connected by this
  release.
- Add organization-owned fleet policy that binds `ALLOW` to caller-supplied
  current/candidate versions and artifact digests.
- Keep external URLs out of signed resolution records because credentials and
  private share tokens can appear in URL user information, query strings,
  fragments, or opaque paths.
- Preserve exact OpenAPM YAML scalar representation and reject custom tags,
  anchors, and aliases so coercion cannot turn a changed state into no change.
- Bind exact Skills v3 JSON number representations, reject malformed UTF-8,
  validate required timestamps and source-specific identity shapes, and keep
  source-lineage replacements out of automatically eligible update pairs.
- Keep ref-only and additive metadata drift visible without scheduling a
  same-artifact preflight, reject manager unions above the schema's bounded
  4,097-change capacity, and keep parser source excerpts out of diagnostics.

## 0.16.0 - 2026-08-23

- Add an open signed challenge-proof format, pinned Ed25519 signer identities,
  V2 control certificates, and mixed V1/V2 certification corpora.
- Add `vigil certify sign` for control providers and `record-signed` for
  organization-side verification against a separately obtained public key.

## 0.15.0 - 2026-08-23

- Add chained Control Proof certificates, weekly freshness policies, baseline
  and authority policy packs, organization status reports, four public JSON
  Schemas, and a weekly 90-day dogfood bundle.
- Add `vigil prove`, a local control-effectiveness check that creates a
  disposable clone, plants six safe change scenarios plus a cleanup check, and returns `HOLD`
  unless every expected PASS, BLOCK, and HOLD result is observed.
- Add Action `mode: prove` for scheduled or on-demand control checks without
  creating a Value Card from the planted run.
- Add `vigil proof-comment`, a deterministic, aggregate-only rendering of an
  intact full receipt for one marker-based pull-request comment. It omits raw
  evidence and refuses non-HTTPS verification links.
- Extend Authority Plan with cross-vendor semantic atoms, control-specific
  partial orders, exact structural approval keys, trusted-base exceptions,
  broader repository configuration discovery, and a 100-revision public
  execution corpus with 100 planted authority expansions.

## 0.14.1 - 2026-08-23

- Correct Marketplace wording now that Agent Authority Plan is released.
- Point CLI examples at the verified GitHub release package while the npm
  registry remains on an older version.

## 0.14.0 - 2026-08-23

- Add `vigil plan`, an exact-base/exact-head authority diff for repository MCP,
  Cursor, VS Code, Claude Code, and Codex settings.
- Block new servers, hosts, tool grants, secret references, writable paths,
  hooks, weaker approval or sandbox settings, and pinned-to-mutable model
  changes. Changed settings the installed adapter does not understand return
  `INCONCLUSIVE`.
- Read exception policy only from the base revision and bind each exception to
  the normalized kind, subject, and resulting value.
- Include Authority Plan in the maintainer and merge-queue receipts installed
  by `vigil protect`.
- Keep secret and header values, URL query strings, and full hook commands
  out of reports.

## 0.13.0 - 2026-08-23

- Add the local-alpha `vigil plan` command. It compares exact Git revisions and
  normalizes repository-declared MCP, Claude Code, and Codex authority into a
  deterministic partial-order change plan. New authority blocks; unsupported
  and incomparable relationships hold; contractions remain visible.
- Add secret-redacted JSON, text, and Markdown plan output, a versioned JSON
  Schema, private atomic output, control-character neutralization, and
  fail-closed parsing. This does not claim live effective authority, external
  adoption, payment, or revenue.
- Add `mode: plan` to the composite GitHub Action. It binds pull-request runs to
  event base/head SHAs and exposes `PASS`, `BLOCK`, or `HOLD` without passing
  the plan through incompatible receipt, value-card, SARIF, or attestation
  processors.

- Add `vigil protect` to discover common repository checks and install the
  exact-commit pull-request gate, merge-queue support, protected base policy,
  retained receipts, and outcome workflow in one command.
- Add calibrated Test Integrity Guard. Direct skips, focused tests, empty
  tests, constant or self-equal assertions, zeroed coverage gates, reduced
  test counts, and verification bypasses block. Broader static findings remain
  advisory unless the repository deliberately enables strict mode.
- Add `vigil test-integrity` for a standalone exact `base..head` scan with an
  ordinary Agent Vigil receipt and reproduction command.
- Publish a 20-case, source-backed adversarial test-integrity corpus across
  JavaScript, TypeScript, Python, Rust, Go, Java, .NET, shell, and browser tests.
  The corpus labels synthetic variants separately from directly reproduced
  public-report mechanisms.
- Publish a dated ledger of 50 primary user reports and a competitive map that
  separates user-reported pain, vendor claims, observed product behavior, and
  unproven market conclusions.

- Add a local-only `vigil upgrade` lane for exact old-versus-new coding-agent
  dependency comparisons without modifying the active installation.
- Require digest-pinned, locally present OCI runner images and prove planted
  network, filesystem, proxy, and inherited-secret containment controls before
  any candidate canary can run.
- Reject Docker endpoints that are not Unix sockets or Windows named pipes,
  avoid ambient `PATH` when selecting the Docker client, and require explicit
  client overrides to be absolute. Resolve one executable, endpoint, and
  sanitized environment binding for each check; use its explicit `--host` for
  image, probe, trial, cleanup, and absence-check calls. The selected client and
  transport remain operator-trusted; a local socket can still proxy another
  daemon. Record the successful transport binding as `localEndpoint` in private
  and public v1 evidence, and require `true` for `SAFE` without publishing the
  endpoint path.
- Give every probe and trial an unpredictable container name, hard-kill the
  client at its deadline, and return `HOLD` unless cleanup verifies that exact
  container name is absent.
- Repeat trusted repository canaries against both artifacts and return bounded
  `SAFE`, `CHANGED`, or `HOLD` evidence. The generated template intentionally
  reports `FAIL`, so first-use scaffolding cannot earn `SAFE` by itself.
- Add private nonce-bound receipts, explicitly requested Ed25519-signed public
  compatibility entries, pinned-key verification, and a static local evidence
  index that excludes repositories, commands, prompts, paths, raw output, and
  environment data. Public canary labels are receipt-specific nonce-blinded
  pseudonyms unless the operator explicitly supplies a public ID.
- At evaluation entry, require a fresh validated config read to equal the
  caller's canonical snapshot; after trials, require its canonical path,
  device/inode identity, and canonical content to match the entry checkpoint.
  Bind its digest and the complete canary harness, require pairwise disjoint
  inputs, and re-inventory artifact and canary trees after execution. These
  checkpoints detect observed changes but do not claim continuous immutability
  against same-host ABA or privileged races.
- Refuse receipt and index outputs that alias keys, inputs, or evaluated trees.
- Escape control and Unicode format characters in human upgrade receipts,
  doctor output, init/index paths, and error messages without changing
  structured evidence.
- Keep Upgrade Guard out of the GitHub Action and hosted workflows until
  hostile candidate execution, adapter fidelity, and external retention have
  been independently established.

Upgrade Guard remains a local alpha within this release. The repository has no
verified external adoption, paying customer, or revenue evidence.

## 0.12.0 - 2026-08-22

- Added optional GitHub artifact attestations for full Agent Vigil receipts.
  The signed custom predicate binds the receipt file, verdict, base and head
  commits, Git tree, policy hash, version, and evidence counts.
- Kept source code, prompts, transcripts, and test output out of the public
  attestation predicate.
- Added `vigil attest` to prepare a predicate and `vigil verify-attestation` to
  verify the GitHub signature and every signed receipt field.
- Verification pins the expected signer workflow and rejects self-hosted runners
  unless the operator makes an explicit exception.
- Added `vigil notary`, a fail-closed check payload builder for a GitHub App. It
  refuses invalid attestations, unexpected commits, and untrusted policies.
- Added `init --attest` and `doctor` checks for the required GitHub workflow
  permissions.
- Replaced the long pull-request summary with a short decision card while
  retaining the full JSON receipt and SARIF artifact.
- Published the predicate schema, setup guide, GitHub App contract, and example
  App manifest. No hosted notary service is included in this release.
- Added adversarial coverage for changed files, replayed commits, mismatched Git
  trees, wrong policies, altered receipts, and webhook signatures.
- Replaced the maintainer profile's required human-review declarations with an
  explicit base-anchored automated review policy. Its commands run in a detached
  checkout of the exact candidate commit and fail closed on nonzero exit,
  timeout, `HEAD` movement, or tracked-file mutation.
- Kept `reviewMode: "human"` for repositories whose own governance requires
  named declarations. Existing policies remain valid.
- Reworked the public page and value-record HTML with readable body type,
  restrained serif headings, plain wording, and no decorative gradients, pills,
  soft shadows, or all-page monospace.
- Added `npm run review:public` to check versions, public wording, local links,
  accessibility labels, first-screen clarity, claim-count consistency, reading
  measure, and repeated template defaults. Agent Vigil no longer requires a
  named human declaration for this release gate.

## 0.11.3 - 2026-08-22

- Publish the canonical npm package as `@sulmusic/agent-vigil`. npm rejected
  the unscoped `agent-vigil` name because it is too similar to the existing,
  separate `agentvigil` package.
- Replace temporary GitHub-package setup commands with exact-version npm
  commands and align the public Marketplace metadata with the live listing.
- Keep the `agent-vigil` and `vigil` executable names unchanged.

## 0.11.2 - 2026-08-22

- Resolve downloaded outcome-receipt paths before loading them. This fixes the
  generated outcome observer when `actions/download-artifact` writes the prior
  receipt under a relative directory.
- Exercise outcome mode with a relative receipt path in the composite-Action
  regression test.

## 0.11.1 - 2026-08-22

- Make generated maintainer workflows install locked dependencies with scripts
  disabled before running the base policy's fresh verification command.
- Collect paginated GitHub review, comment, and Actions-job evidence with the
  hosted runner's supported `gh` and `jq` interface.

Both defects were found by the first real pull request that installed the
published Action on Agent Vigil itself. The failed receipt remains in that pull
request as evidence from Agent Vigil's own use.

## 0.11.0 - 2026-08-22

- Add task-scoped authority contracts that bind allowed repository paths,
  denied paths, action classes, expiry, and tool-result completeness.
- Add `vigil authority`, base-ref contract loading, JSON/SARIF receipts, and an
  `init --profile authority` GitHub workflow.
- Classify observed read/write/test/build/install/network/credential/destructive,
  Git, PR, release, deploy, external-write, and task-creation effects while
  failing closed on unknown or incomplete action evidence.
- Add adversarial fixtures for contract self-widening, path escape, unauthorized
  push, expired authority, compound shell commands, missing results, and
  narrative-only evidence.
- Add `vigil value` and Agent Value Card v1. A card joins a verified receipt to
  observed Codex or Claude Code usage, attributed cost and budget, maintainer
  disposition, review time, and downstream outcome.
- Add text, JSON, Markdown, and private standalone HTML cards with explicit
  `POSITIVE`, `NEGATIVE`, and `INCONCLUSIVE` states.
- Deduplicate streamed Claude assistant usage by message identity, consume the
  greatest Codex cumulative usage snapshot, hash optional billing, review, and
  outcome evidence, and reject transcript/receipt mismatches or tampering.
- Add optional post-run `maxToolCalls`, `maxFailedToolCalls`, and
  `maxObservedTokens` authority limits. A declared token limit requires token
  telemetry.
- Detect exact repeated actions, consecutive failures, and spend without
  observed progress without treating every repeated command as a defect.
- Add `vigil github-evidence` for bounded GitHub PR, review, comment, merge,
  Actions-duration, revert, hotfix, and incident evidence. Generated workflows
  retain the normalized bundle and a Value Card with each receipt.
- Add a separate least-privilege outcome observer. It downloads the prior
  receipt, records final Actions duration and final merge state, and never
  checks out or executes candidate code.
- Add `vigil compare-value` with receipt deduplication, exact task-class groups,
  minimum evidence gates, hashed-cost completeness, review burden, downstream
  adversity, and 95% Wilson intervals.
- Publish dated research notes separating official platform behavior, reported
  user problems, products compared, and the evidence required before further
  investment.

Authority reconciliation is post-execution evidence, not runtime containment or
proof that no unlogged action occurred.
Cost amounts and downstream outcomes remain attributed evidence. `POSITIVE`
requires hashed cost evidence plus hashed acceptance or merge evidence. Artifact
hashes prove file identity, not that contents or allocations are correct.
GitHub Actions elapsed time is not billed USD.

## 0.10.1 - 2026-08-21

- Add fail-closed GitHub merge-queue verification for `merge_group` events.
- Bind the composed queue commit to the event `base_sha` and `head_sha`, load
  policy from the event base, rerun its test command, audit the composed diff,
  and retain JSON plus SARIF receipts.
- Make `vigil init` generate a merge-queue-compatible required check and pin
  the generated Action to the actual CLI version instead of stale v0.9.0.
- Expose the SARIF path as a composite Action output and teach `vigil doctor`
  to diagnose missing merge-queue coverage.
- Recheck `HEAD` after the trusted test command so a command cannot move to a
  different clean commit after the pre-test workspace binding.

The merge-group pass verifies composition and trusted policy. PR-body human
attestations and portable signatures remain PR-phase checks and are not
invented from a merge-group payload that does not contain them.

## 0.10.0 - 2026-08-21

- Add `vigil compare` and receipt-delta v1 for policy, Git-range, signer,
  invariant-check, contradiction, and advisory regression analysis.
- Freeze and publish a paired Agent Vigil/Swarm comparison protocol, baseline,
  machine rows, Wilson intervals, exact McNemar tests, Holm corrections, and a
  fixed-seed paired bootstrap.
- Recognize Cypress test paths, more cross-ecosystem test declarations,
  comment-only changes, cross-file stale callers, and test-only oracle
  relaxation while preserving advisory-default behavior.
- Add negative controls and fail-closed tests for receipt tampering, weaker
  policy, unrelated ranges, missing invariant checks, and advisory deltas.

The comparison is maintainer-authored and non-blind. Its results apply only to
the published corpus and protocol.

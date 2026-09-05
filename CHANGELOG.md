# Changelog

## Unreleased

- Add `vigil run`, a POSIX process-group circuit breaker with a mandatory wall
  limit, optional fail-closed JSONL trajectory limits, and private self-hashed
  receipts that keep correctness, exact cost, and economic value `NOT_CHECKED`.
- Keep deadline and signal enforcement independent from transcript parsing with
  a monotonic supervisor clock and packaged telemetry worker; enforce malformed
  or incomplete requested telemetry immediately when the observed command exits.
- Reject malformed counters, conflicting counter aliases, and totals that are
  internally contradictory before or after streamed-record deduplication, and
  return a supervisor error when final process-group termination cannot be
  confirmed.
- Distinguish Linux zombie-only process groups from executable descendants,
  including runnable threads hidden behind a zombie thread-group leader; require
  stable repeated task-membership snapshots before confirming termination,
  avoid poisoning those snapshots with unchanged `hidepid`-inaccessible
  processes proven to predate the detached session while failing closed for new
  or changed inaccessible entries, and exercise containment under a deliberately
  non-reaping container PID 1.

## 0.24.3 - 2026-09-04

- Stop protection setup before writing files when no test command is found,
  rather than reporting readiness with a placeholder that fails the next step.
- Extend the packed install rehearsal through commit and `doctor`, and require
  repositories without test commands to be rejected without partial setup.

- Keep packaged install instructions valid before and after publication, with
  exact-version checks and a separate link to live distribution status.
- Stop the GitHub download sequence if either download or checksum fails.
- Rehearse the packed README's npm command in an empty repository without
  credentials, using a local registry that serves the actual release tarball.

## 0.24.2 - 2026-09-04

- Install the reviewed public App control workflow on the default branch so the
  Worker dispatch target exists before activation.
- Make the hosted App readiness endpoint fail closed until every check,
  deployment, registration, and Durable Object binding is configured.
- Bind hosted pull-request verdicts to the current issue evidence so a body edit
  cannot reuse a stale PASS.
- Update artifact Actions and GitHub App authentication to their reviewed,
  warning-free runtimes.
- Prove the App-owned gate on live PASS, FAIL, stale-head, rollback, and
  merge-queue staging paths without presenting first-party tests as adoption.

## 0.24.1 - 2026-09-04

- Keep the successful `protect` handoff on the same immutable GitHub release
  package instead of printing an npm command before that version is public.
- Treat packaged release instructions as an immutable release snapshot rather
  than a claim about which distribution channel is currently newest.

## 0.24.0 - 2026-09-04

- Add a production-shaped independent release gate that binds fresh challenges, external allow effects, denied effects, exact executable bytes, managed policy bytes, and current-versus-candidate behavior to short-lived signed evidence.
- Keep six trust roles separate across environment, challenge, observer, route, isolation, and admission signing, with KMS-compatible signing and fail-closed key checks.
- Put exact repository, commit, environment, and artifact authorization behind the public GitHub App deployment-protection path while retaining the protected job's final byte check.
- Record route-event and completion times and refuse admission when either falls outside the signed observer or managed-environment window.
- Retain approved and rejected deployment decisions for bounded webhook replay, including rejections made without a registered authorization.
- Preserve the frozen benchmark and publish a neutral competitor comparison: Agent Vigil leads paired-synthetic separation while Swarm leads constructive-injection recall and lower presumed-clean advisory coverage. No universal winner is claimed.
- Keep production deployment, outside adoption, payment, and revenue as separate unproven gates.

## 0.23.4 - 2026-09-01

- Calibrate suppression and assertion-drop advisories against the frozen corpus, reducing presumed-clean advisory coverage from 57.8% to 44.8% without changing the 220/220 frozen oracle result.
- Present one first-use decision vocabulary across terminal, Markdown, pull-request, and HTML output: PASS, FAIL, or NOT CHECKED, with the matching consequence, evidence, fix, and reproduction command.
- Add the centrally operated public App worker and control workflow template for exact-head pull-request and merge-queue checks without customer-managed keys or Workers. The public service remains inactive until live outside acceptance.
- Publish a neutral identical-diff comparison against Swarm with complete rows, bounded statistics, source commits, and explicit limits; no universal-superiority or revenue claim is made.
- Add a two-commit release-assembly verifier that restricts protected release paths, rebuilds every distributed file, and binds all public Action pins to the reviewed runtime commit.
- Accept GitHub App private keys in either unencrypted RSA PKCS#1 or PKCS#8
  format and normalize them in memory before Web Crypto import.
- Scope the protected pull-request App token to the target repository instead
  of the Agent Vigil source repository.
- Bind merge-queue dispatch to the configured App bot login so installations
  are not limited to one globally unique GitHub App slug.
- Record the first-party live acceptance case in which an App-bound required
  check merged a passing queue composition and blocked a stale composition
  whose earlier pull-request checks were green.

## 0.23.3 - 2026-08-31

- Ship the external merge-queue dispatcher, GitHub App manifest, and exact
  `merge_group` workflow in the npm package so an organization can deploy the
  same reviewed control without rebuilding it from repository source.
- Keep the queue webhook inactive until the App, Worker, main-only environment,
  and negative blocking test are configured and verified.
- Stage npm from immutable stable-tag workflow bytes before publishing the
  matching GitHub release, while retaining separate no-OIDC verification and
  OIDC-only staging jobs.
- Require the release tag commit to be contained in the repository's default
  branch and preserve exact tag, commit, package, tarball, and integrity
  bindings throughout trusted publishing.

## 0.23.2 - 2026-08-30

- Replace vulnerable check-then-use file handling with descriptor-bound,
  no-follow snapshots and identity checks across receipts, policy, transcripts,
  repository evidence, generated output, and trusted Git execution.
- Escape untrusted Markdown and regular-expression text before rendering or
  matching, and validate the one release-time network target before use.
- Add source-scoped CodeQL for JavaScript, TypeScript, Actions, and maintained
  scripts while excluding deterministic generated bundles and hostile fixtures.
- Include the exact five-minute guide in the package and bind the packed README
  to the same v0.23.2 source, so the release cannot point at an older guide.

## 0.23.1 - 2026-08-30

- Point the post-install doctor handoff at the same v0.23.1 package used to
  install the gate, so hermetic-runner repositories do not fall back to the
  pre-runner v0.22.0 CLI.
- List `.agent-vigil-runner.json` in the review, commit, and removal steps when
  an explicit hermetic runner is selected.
- Publish the verified v0.23 compatibility, package digest, browser handoff,
  and distribution state without claiming npm parity.

## 0.23.0 - 2026-08-30

- Add a base-owned `.agent-vigil-runner.json` contract so Python, Rust, Go,
  Java, Ruby, PHP, .NET, pnpm, Yarn, Bun, and Node repositories can select a
  reviewed candidate image by immutable digest and one bounded direct test
  command. Custom setup and test-time network access remain disabled.
- Record the exact hermetic image digest and command in retained harness
  evidence, protect the runner contract from candidate changes, and reject
  floating images, shell composition, symlinks, gitlinks, and altered runner
  configuration.
- Add a common multi-toolchain runner recipe and a provenance- and SBOM-enabled
  GHCR publication workflow. `--runner common` selects the successful public
  build by immutable digest; `--runner-image` remains available for an
  organization-owned image.
- Replace the thousand-line landing README with a short purpose, five-minute
  installation path, result semantics, compatibility boundary, and links to
  advanced controls.
- Run the test suite under one disposable temporary parent and remove it after
  completion, preventing accumulated test fixtures from consuming the host
  filesystem.
- Include the protected-path false-green correction merged in PR #134: a
  governed contradiction cannot be overwritten by a candidate green result.

## 0.22.0 - 2026-08-28

- Let `vigil protect` select and display an immutable reviewed Action commit when
  the operator does not provide `--action-sha`; an explicit pin remains an
  expert override.
- Replace the first-run doctor failure wall with one truthful `PREPARED — not
  active yet` state and exact activation steps.
- Run a disposable differential-proof rehearsal during setup. It demonstrates
  one real regression test that fails on old code and passes on proposed code,
  then blocks a planted weak test that passes on both versions.
- Add the zero-install `vigil check <public-pr-url>` entry point for exact clean
  package builds. Development builds without an embedded source commit refuse
  rather than writing a misleading tool identity.

- Bind `vigil check` to the exact commit embedded in the release package and reject a conflicting `--tool-ref` override.
- Add a hosted five-minute onboarding test that creates a clean disposable repository and exercises the complete no-SHA setup path.

## 0.21.2 - 2026-08-28

- Bind hosted execution to the reviewed Node.js 22.23.2 binaries for Linux x64,
  macOS x64, and macOS arm64. The composite Action now rejects wildcard
  tool-cache versions and system Node fallbacks, verifies the platform digest,
  copies the runtime into a private mode-0500 checkpoint, and verifies that
  checkpoint before its first Node invocation.
- Select the exact Node runtime before checkout, artifact processing, or other
  repository-controlled work in the generated evidence, outcome, continuity,
  and Control Proof workflows. Add a direct hosted differential regression that
  fails on the prior runtime contract and passes on the repaired one.
- Keep the immutable v0.21.1 release as historical evidence and advance the
  package/runtime identity instead of moving or replacing that tag.

## 0.21.1 - 2026-08-28

- Replace the scripted demonstration with a bounded disposable-repository run
  that installs and diagnoses the base-selected protection, inspects immutable
  Action and receipt-retention wiring, and replays three historical failures.
- Add a closed, owner-consented adoption ledger and validator that keeps
  configured repositories, unique receipt hashes, 30-day retention, required
  checks, accepted contradictions, and false-verdict reports separate.
- Extend the public adoption census with oldest and newest sampled workflow-run
  timestamps and a separately labeled 30-day activity span. Public activity is
  not presented as maintainer-confirmed retention.
- Add a weekly evidence workflow that retains the public census and consented
  ledger report for 90 days. The current external-adoption count remains zero.
- Match the current GitHub-hosted `setup-node` runtime contract, where the
  exact tool-cache Node binary is a regular 0777 file. Agent Vigil accepts only
  the expected Node 22 cache path, copies it before candidate execution, and
  verifies the source and private copy fingerprints before use.

## 0.21.0 - 2026-08-27

### Breaking security migration

- Require `--action-sha <reviewed-full-commit>` for every `vigil init` and
  `vigil protect` installation. Generated evidence and outcome workflows pin
  Agent Vigil and supporting Actions to immutable full commits.
- Replace candidate-selected `pull_request` evidence with a base-selected
  `pull_request_target` workflow. The job checks out the event's exact pull
  request head without persisted credentials, validates the base, head, policy,
  event, Action, and workspace bindings, and runs repository-controlled setup
  and tests only inside the fixed Linux hosted Docker boundary.
- Remove candidate-workflow receipt attestation. `init --attest` and
  `protect --attest` now fail closed. Keyless signing remains available only to
  the separate, non-candidate Control Proof workflow; candidate evidence has no
  GitHub token input, OIDC grant, signing authority, or write permission.
- Limit generated hosted execution to plain repositories and supported root
  Node/npm repositories. A hosted test must be one bounded direct
  `node --test` command from `scripts.test` or
  `agentVigil.hostedTestCommand`. Root npm installs use base-owned
  `npm ci --ignore-scripts`; unsupported package managers, layouts,
  toolchains, or indirection fail closed. The local CLI retains broader
  inference, but runs with the local operator's host privileges and is not a
  sandbox.
- Stop generating or accepting a repository-owned `merge_group` evidence path.
  GitHub's ordinary required-status-check selection binds a context or job name,
  not the expected workflow and event identity. A candidate can therefore
  imitate the name. Enforceable pull-request and merge-queue policy requires an
  organization or enterprise required-workflow ruleset, or an external GitHub
  App that validates the exact head and expected evidence source.
- Reduce the generated outcome observer to a read-only `workflow_run` handler
  for the completed evidence run. It snapshots that run's retained receipt,
  Actions records, and pull-request state without checking out or executing
  candidate code. It does not claim continuous close, merge, revert, incident,
  adoption, payment, or revenue observation.
- Harden diff parsing, evidence snapshots, filesystem handling, command and
  authority classification, candidate clone isolation, Docker invocation,
  bounded readers, output identity, and cleanup so malformed, ambiguous, or
  mutable inputs fail closed.
- Validate full Trust Reports recursively before signing, comparing, sealing a
  portable receipt, building continuity evidence, or rendering proof output.
  Unknown fields, malformed summaries, stale hashes, unsafe key/receipt paths,
  and internally inconsistent reports now fail closed.
- Make the public pull-request receipt bind the oldest decisive evidence time,
  public-repository status, freshness policy, and decisive review state.
  Comment-only reviews cannot erase a change request, ambient GitHub tokens are
  not consumed, reads have deadlines and byte limits, and impossible freshness
  receipts cannot verify.
- Split scheduled Control Proof into an unprivileged proof job and a separate
  no-checkout OIDC signer. The signer accepts only a bounded proof/predicate
  artifact and verifies their exact content, source, and hash binding before
  attestation; the generated workflow has no manual or candidate trigger.
- Split npm release verification and packing from the minimal OIDC publish job.
  Publishing is release-event-only, consumes a bounded hash-bound tarball, and
  requires the separately protected `npm-publish` GitHub environment and npm
  Trusted Publisher authorization before it can be considered live.

## 0.20.0 - 2026-08-27

- Add `vigil guard-compat` for process-only Claude Code and Codex control
  checks. It uses one harmless allow marker and one harmless deny marker,
  records `ALLOW`, `DENY`, `DEFER`, `ERROR`, or `UNKNOWN`, binds the receipt to
  exact host and control files, policy, configuration, arguments, and operating
  system, and keeps deployment on `HOLD` until live-host routing is proven.
- Add `vigil guard-route` for a disposable, real-host `PreToolUse` drill. It
  requires one exact allowed `printf` call, one exact denied call, distinct
  host-owned call identifiers, no unexpected routed calls, removed temporary
  configuration, and unchanged ordinary user configuration. One host passing
  cannot stand in for the other, and deployment remains on `HOLD`.
- Add strict guard-route receipt validation and typed continuity events. A
  passing route affirms, a contradictory route revokes, an inconclusive route
  holds, and an unexpected host/control/operating-system binding revokes.
- Add `vigil continuity guard-demo` for the complete two-host state sequence:
  `CURRENT`, controlled `REVOKED`, sticky `REVOKED` after an ordinary green
  route, and `CURRENT` only after independent signed repair. The command labels
  its failure as a fixture and does not claim a real incident or deployment.
- Add a removable GitHub continuity marker with a manual public installation
  vector. The public vector reports `SELF_TEST_PASS`, never `CURRENT`, and
  cannot authorize a protected action.
- Add the offline `@sulmusic/agent-vigil/continuity-staple` TypeScript package
  entry and deterministic signed vectors shared by the library and CLI. The
  vector private key is not retained or packaged.
- Add `vigil continuity terraform-plan-gate` to verify signed continuity before
  inspecting and fingerprinting one exact saved Terraform plan. It never runs
  `terraform apply` and retains hashes, versions, and action counts rather than
  plan values. The protected-action decision uses the verifier's wall clock
  and rechecks staple expiry after plan inspection.
- Refuse guard receipt outputs that replace or alias executables, controls,
  arguments, policy, configuration, or the disposable-profile marker, and fail
  if an initially absent ordinary host configuration appears during a route
  drill.
- Add signed Outcome Mandate and Outcome Receipt v0.1 contracts for exact-base,
  exact-head agent-work acceptance. The verifier binds required rule IDs,
  evidence minimums, trusted requester, evidence, and verifier keys, expiry,
  and optional budget limits to `PASS`, `FAIL`, or `INCONCLUSIVE`; constructors
  reject identical base and head commits.
- Add draft generic, A2A, AP2, x402, ERC-8004, and VCAP outcome signals. Signal
  rendering requires a pinned verifier and remains dry-run with no network or
  money movement.
- Publish closed JSON Schemas, a 50-case adversarial corpus, a local
  red-to-green demonstration, and an inbound non-binding price-reservation
  form. No hosted checkout or paid-demand claim is included.
- Replace the Outcome Verifier landing-page layout with a compact pull-request
  check. The example shows the failed check first, explains it in ordinary
  language, and keeps pricing research off the main product surface.
- Add a disposable two-replica Kubernetes admission lab with default-deny
  verifier egress and an unavailable-verifier drill. It allows fresh `CURRENT`,
  denies missing, tampered, expired, and revoked evidence, and removes its
  cluster and fixtures. This maintainer-run lab is not a production deployment
  or outside adoption.
- Scope the existing coverage thresholds to production TypeScript sources so
  temporary repositories and generated adversarial fixtures cannot dilute the
  reported project coverage.

## 0.19.0 - 2026-08-25

- Add `vigil pr-receipt` for a read-only, no-workflow-change observation of a
  public GitHub pull request. It pins the verifier by full commit, optionally
  signs the normalized receipt with a customer-controlled Ed25519 key, retains
  no source, prompt, transcript, review text, check log, or token, and reports
  `CURRENT`, `HOLD`, `EXPIRED`, or `REVOKED` without authorizing deployment.
- Make secondary GitHub API failures and incomplete pagination explicit
  coverage gaps instead of silently dropping missing review or check evidence.
- State in the receipt that observed execution is not evidence that selected
  checks were sufficient.
- Put the no-workflow command on the public install surface and add a dedicated
  issue form for voluntary, evidence-linked receipt trials.

## 0.18.0 - 2026-08-25

- Extend Test Integrity Guard with eight reconciled agent-change checks for
  hidden Unicode, falsified assertions, pytest collection filtering, disabled
  harness steps, new suppressions, distinctive test-oracle matches, lookalike
  dependency names, and out-of-base-history reads.
- Keep inference-heavy findings advisory, omit matched oracle values from
  receipts, and keep the default scan offline without executing candidate code
  or requiring a public package registry.
- Let Action `mode: prove` create a GitHub/Sigstore attestation over a
  privacy-reduced control-proof predicate. Verification binds the exact proof
  file, proof content hash, source commit, repository, signer workflow, and an
  optional signer-workflow commit while denying self-hosted runners by default.
- Add `vigil certify install-action` for a scheduled and manual exact-commit
  workflow that needs no repository signing secret and retains the proof and
  attestation bundle for 90 days.

## 0.17.0 - 2026-08-24

- Add the offline `vigil continuity` Phase 0: exact-receipt roots, typed append-only
  successor events, optional Ed25519 event signatures, base-revision policy loading,
  and deterministic `CURRENT`, `HOLD`, `EXPIRED`, or `REVOKED` status.
- Keep every state except `CURRENT` from allowing a protected action, retain the
  original historical verdict, and reject subject changes, broken chains,
  duplicate deliveries, clock rollback, untrusted signers, stale sources, and
  privacy-unsafe receipt-tier fields.
- Add authenticated GitHub webhook import for exact merges, reverts, labeled
  hotfixes, and explicitly linked incidents. Store only fixed facts and hashes,
  make repeated deliveries safe, and turn recorder outages into `HOLD`.
- Add a five-step continuity demonstration and an optional exact-commit GitHub
  Action gate. The generated workflow allows only `CURRENT`, reads policy from
  the exact base commit, and contains no deployment command.
- Add a signed GitHub Actions event importer, a manual fork-and-run Continuity
  Lab, and `install-action --self-serve`. The lab uses synthetic evidence and
  no secrets; the production policy still starts with empty trusted-key lists.
- Extend the public census so exact-commit Action use, continuity gates, repeat
  workflow runs, and Continuity Lab runs remain separate observable counts.

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

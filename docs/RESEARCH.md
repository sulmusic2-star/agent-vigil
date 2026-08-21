# What users are actually complaining about

Checked 2026-08-21. This is a source ledger for product decisions, not a claim
that every anecdote is representative.

## Repeated failure patterns

### 1. “Done” is asserted without executable evidence

- A [Claude Code discussion](https://www.reddit.com/r/ClaudeCode/comments/1u9av6m/what_finally_fixed_the_agent_says_its_done_but_it/)
  describes agents claiming a fix and passing tests without reproducible proof.
- An [OpenAI community thread](https://www.reddit.com/r/OpenAI/comments/1ue98q4/i_built_a_tiny_gate_that_stops_ai_coding_agents/)
  asks for exit codes plus output-correctness checks rather than narrative claims.
- A [LangChain agent-evaluation guide](https://www.langchain.com/resources/agent-evals)
  argues that output, tool trajectory, context, and state changes belong in one
  release surface.

**Built response:** PASS / FAIL / INCONCLUSIVE; minimum objective evidence;
single-call matching for command claims; explicit Git baselines.

### 2. Agents change the scoreboard

- A highly discussed [Claude Code thread](https://www.reddit.com/r/ClaudeCode/comments/1txcow8/my_test_suite_is_green_for_the_first_time_in/)
  reports tests being deleted or bypassed to obtain green.
- A follow-up [agent-testing discussion](https://www.reddit.com/r/aiagents/comments/1vnwt2h/your_agent_can_make_the_tests_pass_by_deleting/)
  calls out test deletion, rewritten assertions, and suites that remain green
  despite deliberately broken behavior.
- A targeted [merged-PR investigation](https://www.reddit.com/r/ClaudeCode/comments/1uscaf1/i_tested_whether_coding_agents_actually_cheat_on/)
  found examples including commented-out security tests and weakened TypeScript
  configuration, while also warning that such behavior should not be claimed as
  universal.

**Built response:** deleted-test, test-count-drop, `.skip` / `.only`, assertion
loss, suppression, verification-bypass, and zeroed-coverage detectors.

### 3. Green tests can be stale or hollow

- A [production-behavior discussion](https://www.reddit.com/r/AutonomousCoding/comments/1s9eoeq/agents_need_proof_of_work_not_just_tests/)
  describes unit tests passing while the real browser flow remains broken.
- An [LLM developer discussion](https://www.reddit.com/r/LLMDevs/comments/1u5yt47/my_agent_passed_every_eval_then_quietly_stopped/)
  reports agents passing output evals while no longer calling required tools.
- An [X engineering thread](https://x.com/systematicls/status/2038241033755168959)
  describes weak tests, contract drift, and verification shortcuts under long
  contexts.

**Built response:** test counts are compared, tool-use claims require trajectory
evidence, and receipts bind to `base..head`. Semantic browser correctness remains
outside v0.3 and is named as a limit rather than implied.

### 4. Tool loops and incomplete process state are common

- OpenAI Codex issue [#33999](https://github.com/openai/codex/issues/33999)
  documents repeated invalid wait calls and stalled subagents.
- OpenAI Codex issue [#14731](https://github.com/openai/codex/issues/14731)
  describes turns completing while background processes are still running.
- Claude Code issue [#68093](https://github.com/anthropics/claude-code/issues/68093)
  documents hundreds of repeated empty structured-output calls.
- Gemini CLI discussion [#23240](https://github.com/google-gemini/gemini-cli/discussions/23240)
  asks how to stop repeated tool calls.

**Built response:** exact consecutive-call fingerprints catch one high-signal
loop family. General progress and background-process liveness remain roadmap work.

### 5. Transcript adapters can silently drift

- Claude Code issue [#53516](https://github.com/anthropics/claude-code/issues/53516)
  asks for a stable, versioned JSONL schema because downstream consumers can
  silently mis-parse sessions after format changes.
- Claude Code issue [#37279](https://github.com/anthropics/claude-code/issues/37279)
  reports subagents asserting missing files without first checking the repository.
- Claude plugins issue [#4785](https://github.com/anthropics/claude-plugins-official/issues/4785)
  reports verifier-like plugins claiming checks they did not actually execute.

**Built response:** malformed and unknown JSONL now fails loudly; object-valued
Codex tool inputs are preserved; more failed-command outputs are recognized.

### 6. Teams pay for control surfaces, not isolated detectors

- [CodeRabbit pricing](https://www.coderabbit.ai/pricing) puts multi-repository
  analysis in Pro Plus and RBAC, SSO, audit logs, API access, self-hosting, SLA,
  and multi-organization support in Enterprise.
- [LangSmith pricing](https://www.langchain.com/pricing) separates a paid team
  plan from custom enterprise hosting and access controls.
- [Qodo pricing](https://www.qodo.ai/pricing/) positions enterprise code review
  as SDLC governance under negotiated annual contracts.
- GitHub documents a formal [Marketplace publication route for Actions](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

**Product implication:** the open-source verifier is the wedge. A commercial
product needs organization deployment, policy, attestation, audit retention,
and procurement features. Pricing comparisons are not willingness-to-pay proof.

## Nearby open-source tools

This category is crowded. Agent Vigil should win on precision and integration,
not pretend the category is new.

| Project | Strongest visible idea | Gap Agent Vigil targets |
|---|---|---|
| [did-it](https://github.com/ErickShepherd/did-it) | Per-claim transcript receipts | Cross-agent adapter plus repository anti-gaming in one small Node Action |
| [backcheck](https://github.com/VectorInstitute/backcheck) | Runner-aware transcript verification and freshness | Lightweight GitHub Action, Codex support, SARIF, explicit anti-reward-hacking checks |
| [Treeship](https://github.com/zerkerlabs/treeship) | Signed and chained portable receipts | Smaller coding-agent-specific verifier; no signature claim |
| [agent-receipts](https://github.com/inchwormz/agent-receipts) | Fail-closed hash-chained execution receipts | Natural-language claim reconciliation plus Git-diff integrity checks |
| [PromptWheel](https://github.com/promptwheel-ai/promptwheel) | Source-only replay to expose test gaming | Transcript/repository/trajectory reconciliation with a lower setup cost |

Live GitHub metadata checked 2026-08-20 showed 0 stars for `did-it`, 0 for
`backcheck`, 12 for Treeship, 2 for `agent-receipts`, and 1 for PromptWheel.
These small counts make the narrow open-source category a weak standalone market
signal. Agent Vigil should earn external usage before treating similarity to
these projects as demand evidence.

The most useful competitor evidence is the open Backcheck issue queue:

- [#11](https://github.com/VectorInstitute/backcheck/issues/11) treats hook
  reliability, configurable blocking, time budgets, and a `doctor` command as
  prerequisites for an integration users will not regret installing.
- [#10](https://github.com/VectorInstitute/backcheck/issues/10) identifies
  Homebrew, `npx`, signed/checksummed binaries, and other low-friction install
  paths as adoption work rather than polish.
- [#9](https://github.com/VectorInstitute/backcheck/issues/9) requests evidence
  for migrations, dependencies, docs, deploys, reverts, HTTP checks, PR creation,
  and secret claims—not only tests.
- [#8](https://github.com/VectorInstitute/backcheck/issues/8) identifies changed-line
  coverage and opt-in mutation testing as the next proof that a green suite
  actually exercises changed behavior.
- [#7](https://github.com/VectorInstitute/backcheck/issues/7) describes the
  privacy and transport problem of getting transcripts or minimal receipts into
  CI. Agent Vigil already has the Action and receipt surface, but not signing.
- [#5](https://github.com/VectorInstitute/backcheck/issues/5) calls Codex and
  other adapters the highest-leverage expansion; Agent Vigil now supports Codex,
  but Cursor, Gemini, opencode, Aider, and others remain open territory.

These are another project's proposed features, not customer commitments. They
are useful because they expose installation, false-block, privacy, and breadth
risks that a narrow detector benchmark does not.

## 2026-08-21 competitive update

The narrow category moved quickly. Agent Vigil cannot credibly claim that
receipts, policy, or a required GitHub check are unique.

### Direct competitors

- [Agent Done Or Not](https://github.com/marketplace/actions/agent-done-or-not)
  now has Marketplace distribution, Homebrew/Scoop installers, native Bash and
  PowerShell capture, fresh CI re-execution, a required-check recipe, policy
  scaffolding, PR comments, a Claude Code stop hook, and claim-to-ledger audit.
  Its documented strength is simple command capture and freshness. Agent Vigil
  must not compete by cloning that surface less completely.
- [Treeship](https://github.com/zerkerlabs/treeship) is materially ahead on
  cryptographic receipts: Ed25519, DSSE, hash chains, Merkle checkpoints,
  capability cards, pinned trust roots, offline verification, and unusually
  explicit non-claims. Agent Vigil v0.5 adds optional Ed25519 receipt signing,
  but does not claim equivalent identity or log infrastructure.
- [Agent Receipts](https://github.com/inchwormz/agent-receipts) separates
  integrity, outcome, applicability, and claim status and requires independently
  authenticated evidence for stronger promotion. This typed-trust distinction
  is a useful design constraint for future schema work.
- [Proof Agent](https://github.com/marketplace/actions/proof-agent-verify) uses a
  separate Copilot reviewer for static security/correctness review. It explicitly
  does not execute tests. Agent Vigil's deterministic fresh execution and claim
  reconciliation are complementary rather than a weaker imitation of model
  review.
- [SEA](https://github.com/GodSpeedAI/SEA) and Coder's
  [AI Governance](https://github.com/coder/coder/blob/main/docs/ai-coder/ai-governance.md)
  target pre-execution authority, sandboxing, and fleet policy. Agent Vigil is a
  post-change merge-evidence gate; it should integrate with runtime governance,
  not pretend to replace it.

Live GitHub metadata checked with `gh repo view` on 2026-08-21: Agent Done Or
Not 6 stars, Proof Agent 4, Agent Receipts 2, Treeship 12, Backcheck 0, did-it 0,
and claimcheck 3. These counts show an active but still very early category;
they do not prove broad demand for Agent Vigil.

### Current user failures that shape v0.5

- OpenAI Codex issue
  [#33809](https://github.com/openai/codex/issues/33809) documents the agent
  repeatedly implying a job had started when no evaluator process was running.
  This reinforces process-state evidence rather than final prose alone.
- Codex issue [#36814](https://github.com/openai/codex/issues/36814) reports 179
  identical image-inspection events in an unbounded loop. Exact consecutive-call
  detection is useful but future work needs bounded progress/liveness policies.
- GitHub's [Copilot agent-loop documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/agent-loop)
  separates mechanical `session.idle` from best-effort semantic
  `session.task_complete`. A stopped loop is not proof that the task is done.
- OpenCode issues
  [#10159](https://github.com/anomalyco/opencode/issues/10159) and
  [#21780](https://github.com/anomalyco/opencode/issues/21780) show that exported
  sessions can be truncated or unparsable after compaction/large runs. An
  accepted adapter proves parseability of the supplied export, not transcript
  completeness.
- Gemini CLI issue
  [#27230](https://github.com/google-gemini/gemini-cli/issues/27230) describes
  retry noise that supervisors can misread as permanent failure. Adapters must
  use typed terminal/tool status rather than generic `error` text alone.

### Adapter contracts used in v0.5

The new parsers follow published producer formats rather than guessed local
files:

- [Cursor stream JSON](https://docs.cursor.com/en/cli/reference/output-format)
  documents system, assistant, tool-call start/completion, and terminal result
  events.
- [Gemini CLI headless mode](https://geminicli.com/docs/cli/headless/) documents
  `init`, `message`, `tool_use`, `tool_result`, `error`, and `result` JSONL.
- [GitHub Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
  documents `assistant.message`, `tool.execution_start`, and
  `tool.execution_complete` envelopes; Copilot CLI stores session events under
  `~/.copilot/session-state/`.
- [OpenCode CLI](https://dev.opencode.ai/docs/cli) documents
  `opencode export [sessionID]` JSON and a `--sanitize` mode.
- [Aider configuration](https://aider.chat/docs/config/aider_conf.html) documents
  `.aider.chat.history.md` as the default chat-history file.

### Revised differentiation

Agent Vigil's defensible narrow combination is:

1. cross-agent claim reconciliation against the supplied trajectory;
2. fresh runner-aware test totals, not exit code alone;
3. explicit base/head/tree and base-anchored policy;
4. repository anti-reward-hacking checks;
5. fail-closed adapter drift and an honest INCONCLUSIVE state;
6. a portable receipt with an exact reproduction command.

The v0.5 product should be described as a deterministic AI-change evidence
gate. It is not the first receipt system, a semantic code reviewer, a sandbox,
or a complete enterprise governance plane.

## Product decisions from the evidence

1. **INCONCLUSIVE is a first-class product state.** Missing evidence must not be
   converted into PASS or accused as a lie.
2. **A zero exit status is insufficient when a count was claimed.** Compare the
   observable count.
3. **The selected Git range is part of the receipt.** `HEAD~1` is a convenience,
   not a universal session boundary.
4. **Anti-gaming checks should be named and inspectable.** Users need a rule ID,
   the evidence, and an escape route through an explicit code change—not a hidden
   score.
5. **Local-first is a feature.** Transcripts can contain source code, prompts,
   paths, and secrets. Agent Vigil does not upload them.
6. **Do not claim semantic correctness.** Browser behavior, requirement fit,
   security, and business outcomes need their own evidence providers.
7. **Fail loudly on adapter drift.** Silently discarding malformed JSONL is an
   untrustworthy success path even when the final status would be inconclusive.
8. **Compatibility is a public artifact.** Runner support needs executed fixtures
   and real-toolchain proof, not a list of logos.
9. **Do not require raw transcripts in CI.** The most credible user feedback
   asks for an attestor outside the authoring agent's reach, a clean-checkout
   re-test, and evidence that is hard to fake without publishing the full
   session. The portable receipt gate separates local claim reconciliation from
   independent CI verification. See this
   [unattended-agent discussion](https://www.reddit.com/r/claudeskills/comments/1udroju/if_you_run_coding_agents_unattended_or_in/).
10. **Low noise and control are adoption requirements.** A current
    [code-review complaint thread](https://www.reddit.com/r/codereview/comments/1vssbl8/coderabbit_noise_is_seriously_getting_out_of_hand/)
    repeatedly cites false positives, black-box behavior, and limited
    customization. Agent Vigil should continue emitting bounded deterministic
    rules instead of comment volume.
11. **Receipts are not correctness certificates.** GitHub's own
    [artifact-attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
    states that provenance is not a guarantee of security. Agent Vigil applies
    the same non-claim to behavioral evidence.
12. **Enforcement belongs at the merge boundary.** GitHub
    [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
    can require a status check and pin its expected source to a particular App.
    That is the eventual control-plane enforcement point after external demand
    gates, not a reason to build the App before adoption.

### Public discussion evidence: useful, anecdotal, and noisy

Public comments repeat three practical problems. They are not representative
market research and several posts promote the author's own tool, so they inform
fixtures rather than demand forecasts.

- A [ClaudeAI post](https://www.reddit.com/r/ClaudeAI/comments/1vktwrd/half_of_my_agents_test_runs_left_nothing_readable/)
  reports an audit of 525 local sessions where result-truncating shell pipes left
  many test runs without a readable summary. Agent Vigil's fresh runner avoids
  treating a transcript's missing tail as proof, but it should add an explicit
  truncated-output detector rather than infer dishonesty.
- A [Cursor user report](https://www.reddit.com/r/cursor/comments/1rwm1jn/problems_with_getting_cursor_agent_to_actually/)
  describes an agent repeatedly explaining an edit without making it. This
  supports file-range reconciliation and bounded repeated-action rules.
- A [Hacker News thread](https://news.ycombinator.com/item?id=47327559)
  argues for splitting authority between implementation, tests, and review, and
  notes that shared vague specifications can still let all checks converge on
  the wrong behavior. Agent Vigil cannot make weak requirements adequate.
- Another [Hacker News discussion](https://news.ycombinator.com/item?id=47006615)
  describes review fatigue when small production changes arrive with hundreds
  of generated test lines. This supports changed-test-surface and assertion
  integrity checks, but does not justify a blanket ban on agent-authored tests.

Searches of X did not produce stable, directly inspectable complaint sources in
this pass. No X claim is used as product evidence.

## 2026-08-21 maintainer evidence decision

The repeated high-confidence need is review-cost control with human
responsibility and catching tests. It is not probabilistic AI-authorship
detection.

- [PyTorch's AI policy](https://github.com/pytorch/pytorch/blob/main/AI_POLICY.md)
  requires disclosure, human commentary, understanding, and responsibility;
  fully autonomous contributions are not accepted.
- [attrs' AI policy](https://github.com/python-attrs/attrs/blob/main/.github/AI_POLICY.md)
  names plausible low-quality pull requests and raw AI review comments as
  maintainer burden and places legal/copyright responsibility on the human.
- [Lima's contributor-policy proposal](https://github.com/lima-vm/lima/issues/4982)
  asks for an approved linked issue, one pull request per fix, a concrete “How I
  Tested” section, AI disclosure, and human DCO responsibility.
- The [Linux kernel coding-assistant policy](https://docs.kernel.org/process/coding-assistants.html)
  keeps signoff and DCO responsibility with a human because a tool cannot make
  the certification.
- A direct [open-source maintainer complaint](https://www.reddit.com/r/opensource/comments/1q3f89b/open_source_is_being_ddosed_by_ai_slop_and_github/)
  describes a submitted regression test that also passed on the base revision.
  This is anecdotal evidence, but the failure is deterministic and suitable for
  an adversarial fixture.

Enterprise control guidance points to the same evidence boundary:

- OpenAI's [Codex safety guidance](https://openai.com/index/running-codex-safely/)
  recommends managed configurations, sandbox/approval controls, identity and
  credentials, and OpenTelemetry events for prompts, approvals, tools, MCP use,
  and network decisions.
- AWS's [AI coding-agent control framework](https://aws.amazon.com/blogs/security/balancing-speed-and-safety-a-control-framework-for-ai-coding-agents/)
  separates author-time from build-time controls and combines deterministic
  checks, non-deterministic review, explicit specifications, and selective human
  review.
- JetBrains' [agentic-governance guidance](https://blog.jetbrains.com/ai/2026/06/agentic-ai-governance-designing-for-accountability-and-control/)
  calls for auditability of initiator, intent, touched systems/data, outputs,
  policy violations, time, and cost, with intentional checkpoints and
  evidence-based autonomy thresholds.

### Implemented product response

The maintainer profile verifies the event author/declaration match,
required human declarations, disclosure syntax, linked-issue syntax, file and
line budgets, changed tests, protected paths, fresh head tests, and isolated
base-fail/head-pass regression behavior. It says explicitly where it verifies
syntax or attribution rather than understanding, approval, or semantic
correctness.

This is a narrower moat than a generic governance dashboard:

1. a growing public corpus of non-catching regression tests;
2. base-anchored and reproducible evidence rules;
3. cross-agent transcript receipts when users have them;
4. transcript-free maintainer receipts when they do not;
5. public adoption measurement that does not convert references into users.

Sandbox/orchestration products and AI-slop classifiers remain integration or
competitor categories. Agent Vigil does not imitate them in v0.8.

## v0.8 release landscape recheck

Live repository metadata and linked benchmark artifacts were rechecked on
2026-08-21. Stars are discovery signals, not active-user counts.

- [Swarm Orchestrator](https://github.com/moonrunnerkc/swarm-orchestrator)
  is the strongest public-proof competitor found in this pass: 105 stars, an
  npm install, a linked 303/325 planted-defect result, and a reproducible
  [18-PR report](https://github.com/moonrunnerkc/swarm-orchestrator/blob/main/benchmarks/real-prs/REAL-WORLD-REPORT.md).
  That report records 0.11 arbiter-labeled false alarms per PR and zero
  true-cheat findings in the merged-PR corpus; it explicitly says the arbiter
  is not ground truth. Agent Vigil should copy the evidence discipline, not its
  architecture or claims.
- [Agent Done Or Not](https://github.com/mohamedzhioua/agent-done-or-not)
  had 6 stars and npm version 0.13.1, and its README linked a live Marketplace
  Action. It remains the distribution and author-time stop-hook benchmark.
- [Obsigna](https://github.com/agent-receipts/obsigna) had 20 stars,
  [Treeship](https://github.com/zerkerlabs/treeship) 12, and
  [Signet](https://github.com/Prismer-AI/signet) 37. Their public surfaces are
  materially deeper on signed, chained, offline-verifiable agent-action
  receipts. Agent Vigil should not claim general receipt-protocol leadership.
- [OpenReview](https://github.com/vercel-labs/openreview) had 1,510 stars and
  [Kodus](https://github.com/kodustech/kodus-ai) 1,320. Those projects lead on
  visible AI review and GitHub/self-hosted workflow adoption. Agent Vigil's
  deterministic change-evidence gate is a different job.

The release response is deliberately bounded: three first-party historical
failures with exact revisions and replays, a visually inspected installation
page, npm/Marketplace publication metadata, and a permission-first maintainer
trial ledger. First-party cases remain outside external-adoption totals.

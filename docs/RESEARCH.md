# What users are actually complaining about

Checked 2026-08-20. This is a source ledger for product decisions, not a claim
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

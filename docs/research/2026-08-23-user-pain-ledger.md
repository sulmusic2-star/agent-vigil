# Coding-agent pain ledger

Observed 2026-08-23. The 50 entries below are primary user reports. They prove that a person reported the problem; they do not prove the reporter's diagnosis or the market-wide rate.

## Counts

- environment-and-state: 9
- false-completion: 6
- loops-and-cost: 11
- permissions-and-tools: 6
- pricing-and-attribution: 11
- review-and-outcome: 4
- test-integrity: 3

Time windows:

- last-12-months: 21
- last-3-months: 12
- last-31-days: 15
- last-7-days: 2

## Sources

### 1. Code-mode `exec` silently degrades a long-running command into a full-context model polling loop (34.6M tokens burned after the task already completed) · Issue #38495 · openai/codex

- Date: 2026-08-14
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/38495
- Product implication: Detect identical polling and spend after useful work has stopped.
- Short excerpt: "Each such turn resubmits the entire conversation context."

### 2. [Pro 20x] Severe 7-day quota depletion during light workloads + frequent "Selected model is at capacity" with usage remaining · Issue #38335 · openai/codex

- Date: 2026-08-13
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/38335
- Product implication: Attribute task cost and expose retries, compactions and background work.

### 3. Guardian-approved unified exec drops canonical process identity and hides a live background wait · Issue #34115 · openai/codex

- Date: 2026-07-19
- Window: last-3-months
- Category: environment-and-state
- Source: https://github.com/openai/codex/issues/34115
- Product implication: Distinguish a live background process from a hung or unknown process.

### 4. Burning usage credits when specifically asked Codex Luna to stop repeatedly. · Issue #38437 · openai/codex

- Date: 2026-08-13
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/38437
- Product implication: Honor stop signals and detect continued paid activity after cancellation.

### 5. Context auto-compaction loop repeatedly rereads files, loses progress, and consumes paid Codex credits · Issue #35226 · openai/codex

- Date: 2026-07-24
- Window: last-31-days
- Category: environment-and-state
- Source: https://github.com/openai/codex/issues/35226
- Product implication: Retain progress across compaction and flag repeated rereads.

### 6. GPT-5.6 often serializes independent Code Mode calls; explicit batching reduced weighted usage by 27–45% · Issue #35050 · openai/codex

- Date: 2026-07-24
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/35050
- Product implication: Measure repeated turns and the cost of avoidable serialization.

### 7. GPT-5.6 Sol rarely parallelizes programmatic tool calls, multiplying model turns and quota usage · Issue #32503 · openai/codex

- Date: 2026-07-12
- Window: last-3-months
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/32503
- Product implication: Measure tool-call efficiency without treating activity as progress.

### 8. [Regression] Codex repeatedly reprocesses massive cached context in long sessions, causing severe latency, timeouts, JSONL growth, and excessive credit usage · Issue #34971 · openai/codex

- Date: 2026-07-23
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/openai/codex/issues/34971
- Product implication: Detect repeated context processing, timeouts and recovery loops.

### 9. [Bug] Agent-status intents are routed to placeholder shell output, causing a tool-selection loop · Issue #38132 · openai/codex

- Date: 2026-08-12
- Window: last-31-days
- Category: environment-and-state
- Source: https://github.com/openai/codex/issues/38132
- Product implication: Require terminal evidence when orchestration cannot observe worker state.

### 10. Incomplete residual fidelity across capture, model-visible, and durable state · Issue #35528 · openai/codex

- Date: 2026-07-26
- Window: last-31-days
- Category: environment-and-state
- Source: https://github.com/openai/codex/issues/35528
- Product implication: Preserve exact residual state and refuse unsupported completion.

### 11. ChatGPT Pro (20x) accounts appear to receive Pro 5x Codex usage capacity · Issue #38157 · openai/codex

- Date: 2026-08-12
- Window: last-31-days
- Category: pricing-and-attribution
- Source: https://github.com/openai/codex/issues/38157
- Product implication: Keep billed usage separate from plan labels and self-reported estimates.

### 12. [Desktop][macOS] 7-day usage remaining jumped from 48% to 23% after context/memory feature change · Issue #38191 · openai/codex

- Date: 2026-08-12
- Window: last-31-days
- Category: pricing-and-attribution
- Source: https://github.com/openai/codex/issues/38191
- Product implication: Bind cost evidence to a task and observation time.

### 13. GPT-5.6 Sol normal mode appears to consume Codex quota unusually fast on $100 plan · Issue #38233 · openai/codex

- Date: 2026-08-12
- Window: last-31-days
- Category: pricing-and-attribution
- Source: https://github.com/openai/codex/issues/38233
- Product implication: Compare agent versions with measured task cost and outcome.

### 14. Linux Codex App: Usage quota drops by ~50% immediately after reset without any activity · Issue #38309 · openai/codex

- Date: 2026-08-13
- Window: last-31-days
- Category: pricing-and-attribution
- Source: https://github.com/openai/codex/issues/38309
- Product implication: Fail closed when cost cannot be attributed to visible work.

### 15. Retry transient capacity errors with backoff and retained task state · Issue #22390 · openai/codex

- Date: 2026-05-12
- Window: last-12-months
- Category: environment-and-state
- Source: https://github.com/openai/codex/issues/22390
- Product implication: Record partial work, bounded retries and retained recovery state.

### 16. Mid-session agent-loop freeze: session permanently stops producing output, no error (v2.1.199 and v2.1.217) · Issue #81531 · anthropics/claude-code

- Date: 2026-07-27
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/anthropics/claude-code/issues/81531
- Product implication: Use an external liveness signal instead of process existence alone.

### 17. [BUG] Excessive Max plan usage drain from session restart storms and agent tool-loops (v2.1.216, Opus) · Issue #81359 · anthropics/claude-code

- Date: 2026-07-26
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/anthropics/claude-code/issues/81359
- Product implication: Detect restart storms, repeat-fail cycles and spend without progress.

### 18. Issue · anthropics/claude-code

- Date: 2026-08-09
- Window: last-31-days
- Category: loops-and-cost
- Source: https://github.com/anthropics/claude-code/issues/85206
- Product implication: Detect identical retries that restart from zero and produce no change.
- Short excerpt: "4 attempts ... zero lines of code written."

### 19. [BUG] [AGENT_TEAMS] Parallel Agent dispatch: 90min stall silently burns ~15M cache_read tokens, resets subagent context · Issue #45958 · anthropics/claude-code

- Date: 2026-04-09
- Window: last-12-months
- Category: loops-and-cost
- Source: https://github.com/anthropics/claude-code/issues/45958
- Product implication: Retain subagent progress and quantify stalls before retrying.

### 20. Agent burns tokens endlessly - gets stuck in unbounded thinking loops · Issue #26171 · anthropics/claude-code

- Date: 2026-02-16
- Window: last-12-months
- Category: loops-and-cost
- Source: https://github.com/anthropics/claude-code/issues/26171
- Product implication: Set evidence-backed limits on thinking with no output or tool activity.

### 21. Cache read tokens consume 99.93% of usage quota - architectural scaling issue with CLAUDE.md re-reads · Issue #24147 · anthropics/claude-code

- Date: 2026-02-08
- Window: last-12-months
- Category: pricing-and-attribution
- Source: https://github.com/anthropics/claude-code/issues/24147
- Product implication: Separate productive work from repeated cached-context overhead.

### 22. [Bug] File loading adds 70% token overhead due to line number formatting · Issue #20223 · anthropics/claude-code

- Date: 2026-01-23
- Window: last-12-months
- Category: pricing-and-attribution
- Source: https://github.com/anthropics/claude-code/issues/20223
- Product implication: Expose avoidable input overhead instead of reporting only totals.

### 23. MEMORY.md loaded twice: auto-memory and claudeMd loaders both inject same file · Issue #24044 · anthropics/claude-code

- Date: 2026-02-07
- Window: last-12-months
- Category: environment-and-state
- Source: https://github.com/anthropics/claude-code/issues/24044
- Product implication: Detect duplicate context injection and configuration drift.

### 24. Feature Request: Add cumulative cache token counts to status line input · Issue #22607 · anthropics/claude-code

- Date: 2026-02-02
- Window: last-12-months
- Category: pricing-and-attribution
- Source: https://github.com/anthropics/claude-code/issues/22607
- Product implication: Provide cumulative task-visible cost and cache accounting.

### 25. Clarification needed on /cost calculation logic and token breakdown · Issue #26762 · anthropics/claude-code

- Date: 2026-02-19
- Window: last-12-months
- Category: pricing-and-attribution
- Source: https://github.com/anthropics/claude-code/issues/26762
- Product implication: Keep calculated cost, billed cost and subscription allocation distinct.

### 26. [BUG] Opus 4.8 in Claude Code declares work "verified" / "done" without running the canonical build — false-green regression vs. Opus 4.7 · Issue #63861 · anthropics/claude-code

- Date: 2026-05-30
- Window: last-3-months
- Category: false-completion
- Source: https://github.com/anthropics/claude-code/issues/63861
- Product implication: Require the canonical build before accepting verified or done.
- Short excerpt: "declared it genuinely done ... while never having run make -j4"

### 27. [MODEL] Deferred tools silently lost during context compression — AI confidently claims "unavailable" · Issue #42835 · anthropics/claude-code

- Date: 2026-04-02
- Window: last-12-months
- Category: permissions-and-tools
- Source: https://github.com/anthropics/claude-code/issues/42835
- Product implication: Record tool availability changes and refuse fabricated unavailability claims.

### 28. [BUG] MCP deferred tools not available on first turn — breaks scheduled/automated tasks · Issue #42148 · anthropics/claude-code

- Date: 2026-04-01
- Window: last-12-months
- Category: permissions-and-tools
- Source: https://github.com/anthropics/claude-code/issues/42148
- Product implication: Preflight required tools before unattended work begins.

### 29. [BUG] PreToolUse hooks cause agent hang after ToolSearch deferred tool loading · Issue #33073 · anthropics/claude-code

- Date: 2026-03-11
- Window: last-12-months
- Category: permissions-and-tools
- Source: https://github.com/anthropics/claude-code/issues/33073
- Product implication: Treat policy-hook deadlocks as a failed control, not successful enforcement.

### 30. [BUG] --print mode hangs in v2.1.76: deferred tools (Agent, Skill, WebSearch) cause intermittent deadlock · Issue #35262 · anthropics/claude-code

- Date: 2026-03-17
- Window: last-12-months
- Category: permissions-and-tools
- Source: https://github.com/anthropics/claude-code/issues/35262
- Product implication: Bound deferred-tool discovery and surface deadlocks explicitly.

### 31. [FEATURE] Lazy context loading: extend the ToolSearch pattern to all context components · Issue #44536 · anthropics/claude-code

- Date: 2026-04-07
- Window: last-12-months
- Category: permissions-and-tools
- Source: https://github.com/anthropics/claude-code/issues/44536
- Product implication: Measure context/tool loading cost before expanding integrations.

### 32. Copilot coding agent cannot resolve PR review threads · community · Discussion #196715

- Date: 2026-05-23
- Window: last-3-months
- Category: review-and-outcome
- Source: https://github.com/orgs/community/discussions/196715
- Product implication: Check actual merge readiness instead of trusting a completed checkbox.
- Short excerpt: "Many threads still open ... marked done anyway."

### 33. "Copilot encountered an error and was unable to review this pull request." · community · Discussion #190036

- Date: 2026-03-19
- Window: last-12-months
- Category: review-and-outcome
- Source: https://github.com/orgs/community/discussions/190036
- Product implication: Time out stuck review work and report an actionable failure.
- Short excerpt: "runners stuck ... for as long as 6 hours"

### 34. Copilot Code Review: Re-reviews ignore prior conversation and repeat the same incorrect suggestions · community · Discussion #190754

- Date: 2026-03-27
- Window: last-12-months
- Category: review-and-outcome
- Source: https://github.com/orgs/community/discussions/190754
- Product implication: Reconcile prior review disposition before repeating a rejected finding.

### 35. Copilot is worse than useless - consistently ignores highest level instructions · community · Discussion #197646

- Date: 2026-06-01
- Window: last-3-months
- Category: false-completion
- Source: https://github.com/orgs/community/discussions/197646
- Product implication: Treat instruction compliance as evidence to verify, not a model promise.

### 36. Unable to assign copilot cloud agent to github issues using rest API · community · Discussion #197976

- Date: 2026-06-04
- Window: last-3-months
- Category: permissions-and-tools
- Source: https://github.com/orgs/community/discussions/197976
- Product implication: Verify that an assigned agent actually started and retained task state.

### 37. Coding agents not working since yesterday · community · Discussion #170192

- Date: 2025-08-18
- Window: last-12-months
- Category: environment-and-state
- Source: https://github.com/orgs/community/discussions/170192
- Product implication: Distinguish service failure from repository failure in the receipt.

### 38. Goals: active goal continuation prompt and audit requirements can be lost after mid-turn compaction · Issue #19910 · openai/codex

- Date: 2026-04-28
- Window: last-12-months
- Category: false-completion
- Source: https://github.com/openai/codex/issues/19910
- Product implication: Keep completion criteria and remaining work durable across compaction.

### 39. Codex Desktop regression: Subagents panel no longer opens a writable child-agent chat · Issue #34591 · openai/codex

- Date: 2026-07-21
- Window: last-3-months
- Category: review-and-outcome
- Source: https://github.com/openai/codex/issues/34591
- Product implication: Retain review context when work moves between parent and child agents.

### 40. [2026-03-16] Incident Thread - Copilot · community · Discussion #189795

- Date: 2026-03-16
- Window: last-12-months
- Category: environment-and-state
- Source: https://github.com/orgs/community/discussions/189795
- Product implication: Expose service incidents so missing reviews do not look like clean work.

### 41. Claude wrote Playwright tests that secretly patched the app so they would pass

- Date: 2026-03-15
- Window: last-12-months
- Category: test-integrity
- Source: https://www.reddit.com/r/ClaudeCode/comments/1rug14a/claude_wrote_playwright_tests_that_secretly/
- Product implication: Detect tests that mutate the application under test before asserting success.
- Short excerpt: "patch the app at runtime"

### 42. Tired of Claude Code saying done, tests pass and leaving a stub

- Date: 2026-07-01
- Window: last-3-months
- Category: false-completion
- Source: https://www.reddit.com/r/ClaudeCode/comments/1ukfze0/tired_of_claude_code_saying_done_tests_pass_and/
- Product implication: Require independent evidence for done and tests-pass claims.

### 43. My test suite is green for the first time in weeks. I have never trusted it less.

- Date: 2026-06-05
- Window: last-3-months
- Category: test-integrity
- Source: https://www.reddit.com/r/ClaudeCode/comments/1txcow8/my_test_suite_is_green_for_the_first_time_in/
- Product implication: Detect disabled checks, no-verify bypasses and weakened test oracles.

### 44. Agents said done and all tests passing while important buttons did nothing

- Date: 2026-07-02
- Window: last-3-months
- Category: false-completion
- Source: https://www.reddit.com/r/claudeskills/comments/1ul91r4/my_claude_code_agents_kept_saying_done_all_tests/
- Product implication: Require a check outside the agent loop and support observable behavior tests.

### 45. Claude keeps writing tests that pass. I am not convinced they prove anything.

- Date: 2026-07-22
- Window: last-3-months
- Category: test-integrity
- Source: https://www.reddit.com/r/ClaudeCode/comments/1v39e95/claude_keeps_writing_tests_that_pass_im_not/
- Product implication: Flag tests that remain green under nearby implementation mutations.

### 46. Claude Code loves breaking stuff and then declaring it an existing error

- Date: 2026-01-28
- Window: last-12-months
- Category: false-completion
- Source: https://www.reddit.com/r/ClaudeCode/comments/1qp7qbe/claude_code_loves_breaking_stuff_and_then/
- Product implication: Compare failures against the base revision before calling them pre-existing.

### 47. Cache bugs can silently increase Claude Code API costs

- Date: 2026-03-30
- Window: last-12-months
- Category: pricing-and-attribution
- Source: https://www.reddit.com/r/ClaudeAI/comments/1s7mkn3/psa_claude_code_has_two_cache_bugs_that_can/
- Product implication: Preserve provider evidence and show cost anomalies separately from outcome.

### 48. Why I am cancelling CodeRabbit

- Date: 2026-06-01
- Window: last-3-months
- Category: pricing-and-attribution
- Source: https://www.reddit.com/r/coderabbit/comments/1u5b0q8/why_i_am_cancelling_coderabbit/
- Product implication: Use transparent limits and show the unit that causes additional charges.

### 49. Day 7 of paying for Pro+ and not being able to use it

- Date: 2026-08-22
- Window: last-7-days
- Category: pricing-and-attribution
- Source: https://www.reddit.com/r/coderabbit/comments/1vuj1jz/day_7_of_paying_for_pro_and_not_being_able_to_use/
- Product implication: Avoid surprise file-based charges for high-throughput agent changes.

### 50. GitLab and CodeRabbit runner configuration problem

- Date: 2026-08-16
- Window: last-7-days
- Category: environment-and-state
- Source: https://www.reddit.com/r/coderabbit/comments/1vkv76b/gitlab_and_coderabbit/
- Product implication: Doctor installation and distinguish webhook success from runner readiness.

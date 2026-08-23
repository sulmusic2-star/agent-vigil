# Agent Upgrade Guard update-pair corpus

As of 2026-08-23, this local corpus contains 15 immutable npm update pairs
across coding-agent CLIs, MCP SDKs, MCP servers, a gateway, an inspector, and
an Agent Plugins implementation. [`pairs.json`](pairs.json) is the authoritative
artifact lock: it records every tarball URL, locally computed SHA-256, npm
SHA-512 integrity value, source commit, evidence URL, expected signal, adapter
status, and safety boundary.

The durable corpus records 30 exact tarball identities and hashes. It does not
commit or durably retain the third-party tarball files, generated execution
logs, or private nonce-bearing receipts. Gitignored working copies can remain
on the local research machine, but they are not part of this Git anchor and
must not be treated as published or independently recoverable evidence.

The published metadata anchor can be checked without those private/generated
files:

```sh
node verify-durable-corpus.mjs
```

That command verifies the ten frozen durable-file SHA-256 commitments in
`metadata/corpus-validation.json`. It does not replay the historical tarball,
receipt, Docker, or regression executions.

The frozen runner was Agent Vigil commit
`c279c5e77f69f0898787daf4aeb0eea76f80accf`; its freshly compiled CLI SHA-256
was `5b11518ad92df19b424f7fe10a80f17648e0476e09f0c2cf3e97337070a72c8f`.
The exact runner image was
`node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`.

| # | Exact old → new pair | Documented material behavior | Regression evidence | Trusted canary and expected signal | Current adapter result | Primary source |
|---:|---|---|---|---|---|---|
| 1 | `@openai/codex` 0.117.0 → 0.118.0 | Project-local `.codex` protection and Linux sandbox changes | Official-repository user report: sandboxed commands fail before execution | Resolve the platform bundle and test a project-local `.codex`; expected PASS → FAIL for the reported case | `CHANGED` on wrapper references; runtime regression not reproduced | [0.118 release](https://github.com/openai/codex/releases/tag/rust-v0.118.0) · [regression #16790](https://github.com/openai/codex/issues/16790) |
| 2 | `@anthropic-ai/claude-code` 2.1.94 → 2.1.96 | Bedrock authorization repair | Vendor says 2.1.96 fixes a 403 regression introduced in 2.1.94 | Hash-locked inert builder/SDK semantics; expected missing Authorization → preserved Bearer shape | **Reproduced statically:** old `skipAuth` deletes Authorization; new `apiKey` path preserves it. Generic 4 MiB directory adapter remains blocked | [2.1.96 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.96) |
| 3 | `@google/gemini-cli` 0.56.0 → 0.57.0-preview.0 | Cancellation rollback, timeouts, disabled-agent behavior, IDE directory checks, tool/media turns | No regression classification assigned to the pair | Inert event-state replay; expected multiple changed state observations | Not run: about 98 MiB unpacked and 16.6 MiB maximum file | [preview release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.57.0-preview.0) |
| 4 | `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 | stdio buffer limit, parsed media types, SSE keep-alive lifecycle | Ordinary corrective release | Static transport modules plus later inert boundary traffic; expected `CHANGED` | `CHANGED`; containment `PASS` | [1.30.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0) |
| 5 | `@modelcontextprotocol/inspector` 2.1.0 → 2.2.0 | Published Apps sandbox proxy restored | Maintainer-confirmed published-package defect; Apps were non-functional | Require `clients/web/static/sandbox_proxy.html`; expected missing → present | `CHANGED`; defect reproduced statically; containment `PASS` | [2.2.0 release](https://github.com/modelcontextprotocol/inspector/releases/tag/2.2.0) · [maintainer discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3198) |
| 6 | filesystem MCP 2026.7.4 → 2026.7.10 | Invalid `blob` fallback replaced by MCP `resource`; closed-world annotations added | Corrective protocol behavior, not labeled regression here | Static content union and annotations; expected `CHANGED` | `CHANGED`; containment `PASS` | [content fix](https://github.com/modelcontextprotocol/servers/commit/97b70ee25209) · [release](https://github.com/modelcontextprotocol/servers/releases/tag/2026.7.10) |
| 7 | memory MCP 2026.1.26 → 2026.7.4 | Connected relations retained; graph exposed as subscribable Resource | Corrective behavior, not labeled regression here | Three-node relation fixture plus resource URI; expected `CHANGED` | `CHANGED` statically; containment `PASS` | [relation fix](https://github.com/modelcontextprotocol/servers/commit/ca7ea2253ee0) · [resource](https://github.com/modelcontextprotocol/servers/commit/7b1170d1da1e) |
| 8 | `@playwright/mcp` 0.0.78 → 0.0.79 | WebP, settle timeout, reconnect and config behavior; legacy option/protocol removal | Mixed feature/fix release | CLI/tool contract snapshot; expected `CHANGED` | `CHANGED`; containment `PASS` | [0.0.79 release](https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.79) |
| 9 | Notion MCP 1.9.1 → 2.0.0 | Breaking database → data-source tool and parameter migration | Explicit breaking release, not an accidental regression | Extract OpenAPI operation IDs/API date; expected `CHANGED` | `CHANGED`; containment `PASS` | [breaking migration](https://github.com/makenotion/notion-mcp-server#%EF%B8%8F-version-200-breaking-changes) · [exact compare](https://github.com/makenotion/notion-mcp-server/compare/d5a213ae8e47459425e05b2369154a1c7d3c78f1...433f0d3bbd080a8147c67826c84c41ae81ff2e15) |
| 10 | `mcp-remote` 0.1.41 → 0.1.42 | Stale OAuth client registrations invalidated when callback URI changes | Corrective OAuth behavior | Inert cached-registration fixture; expected `CHANGED` | `CHANGED` statically; containment `PASS` | [0.1.42 release](https://github.com/geelen/mcp-remote/releases/tag/v0.1.42) |
| 11 | `supergateway` 3.3.0 → 3.4.0 | 3.3 concurrency path rolled back | Maintainer-confirmed: some MCP servers hung; upstream discussion identifies default-one queueing as the root cause | Hash-locked runtime semantics plus trusted scheduler; expected second request queued → both reach transport path | **Causal hang state reproduced:** 3.3 queues the second long-lived request before transport without timeout; 3.4 removes that acquire barrier (not an end-to-end 3.4 proof) | [3.4.0 rollback](https://github.com/supercorp-ai/supergateway/releases/tag/v3.4.0) · [root-cause discussion](https://github.com/supercorp-ai/supergateway/pull/52) |
| 12 | `chrome-devtools-mcp` 1.3.0 → 1.4.0 | Skills folder enters published npm artifact | Ordinary feature/fix release | Packaged skills and frontmatter validation; expected missing → present | Not run: 8.48 MiB bundle exceeds 4 MiB file bound | [1.4.0 release](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.4.0) |
| 13 | `opencode-ai` 1.18.20 → 1.18.21 | Unknown finish reason now continues instead of stopping early | Corrective release, not labeled regression here | Inert provider-event replay after platform resolution; expected stopped → continue | `CHANGED` on wrapper references; runtime behavior not reproduced | [1.18.21 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.21) |
| 14 | `@github/copilot` 1.0.79 → 1.0.80-0 | MCP re-enable flag plus breaking Agent Plugins component-root migration | Explicit breaking prerelease | Harmless dual-layout plugin discovery fixture; expected root components to disappear | `CHANGED` on wrapper/build contract; platform discovery not reproduced | [1.0.80-0 release](https://github.com/github/copilot-cli/releases/tag/v1.0.80-0) |
| 15 | `@sentry/mcp-server` 0.36.0 → 0.37.0 | Catalog becomes default; generic tool names receive Sentry prefixes; Node/export contract changes | Intentional migration/fixes | Tool-name and package contract snapshot; expected `CHANGED` | `CHANGED`; containment `PASS` | [exact compare](https://github.com/getsentry/sentry-mcp/compare/0.36.0...0.37.0) · [tool rename](https://github.com/getsentry/sentry-mcp/commit/d3f133e6de38) |

## Result boundary

- 30/30 tarballs matched both npm's SHA-1 and SHA-512 metadata; a local SHA-256
  was recorded for each.
- Twelve exact pairs were accepted by the current filesystem bounds. All twelve
  established containment, produced one stable comparable canary, and returned
  `CHANGED`; none returned a false `SAFE` in this deliberately change-positive
  set.
- Claude Code, Gemini CLI, and Chrome DevTools MCP were deliberately not
  truncated or rewritten. Their failures to fit are adapter requirements, not
  product verdicts. Claude now also has a separate, purpose-built read-only
  tar scanner; that does not change the generic directory adapter's `NOT_RUN`.
- Four rows carry genuine material regression evidence: Codex, Claude Code,
  Inspector, and Supergateway. Three are now independently reproduced at their
  stated proof levels: Inspector's missing published file, Claude's exact
  pre-dispatch Authorization removal, and Supergateway's exact default-one
  queued-before-transport-without-timeout state. Codex remains sourced but
  unreproduced.
- Package code, install scripts, platform binaries, browsers, MCP servers,
  provider requests, OAuth flows, and user accounts were not executed or used.

The two added hash-locked proofs, the existing Inspector proof, artifact locks,
negative controls, and rerun command are described in
[`regressions/README.md`](regressions/README.md) and
[`metadata/regression-proof.json`](metadata/regression-proof.json). The
immediate remaining product work is an npm dependency-closure adapter for
wrapper packages, streaming safe inspection for large regular files, and a
Codex sandbox canary. Those additions are still necessary before claiming all
15 pairs ran through the generic directory adapter or all four material
regressions were independently reproduced.

## External first-100 registration

The selected 15-pair feasibility corpus above is not part of the external
problem-frequency sample. The separate
[`frequency/first-100-registration.json`](frequency/first-100-registration.json)
freezes the chronological inclusion, exclusion, component-cap, materiality,
and interpretation rules before R0. Its detached Ed25519 signature and public
key are retained beside the registration. The initial ledger contains zero
pair entries, so this registration establishes no external frequency result.

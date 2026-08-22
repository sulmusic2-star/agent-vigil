# AI Change Episode v1

**Status:** product contract draft; not yet implemented

**Date:** 2026-08-22

**Purpose:** bind an agent-assisted engineering task to authority, observed
actions, immutable code, independent verification, maintainer disposition,
downstream outcome, and cost without requiring prompt or source-code upload.

An episode is not a transcript. It is an evidence envelope whose claims point
to typed observations and whose unknowns remain explicit.

## Required closure states

Every episode closes as exactly one of:

- `PASS`: all required deterministic policy claims are supported and no
  material contradiction remains;
- `FAIL`: at least one required deterministic claim is contradicted or a
  prohibited action is observed;
- `INCONCLUSIVE`: required evidence is missing, ambiguous, stale, or cannot be
  bound to the stated change.

`PASS` does not mean the code is bug-free or secure. It means the configured
evidence policy passed for this episode.

## Canonical envelope

```json
{
  "schema": "ai-change-episode-v1",
  "episodeId": "urn:uuid:...",
  "openedAt": "RFC3339",
  "closedAt": "RFC3339-or-null",
  "privacyTier": "receipt|metadata|full-local",
  "subject": {
    "repositoryHash": "sha256:...",
    "baseSha": "40-or-64-hex",
    "headSha": "40-or-64-hex",
    "changeRef": "optional-provider-reference"
  },
  "authority": {
    "issuer": "human|policy|delegating-agent",
    "taskHash": "sha256:...",
    "allowedScopes": [],
    "prohibitedActions": [],
    "expiresAt": "RFC3339-or-null",
    "parentEpisodeId": null
  },
  "budget": {
    "currency": "USD",
    "hardLimit": null,
    "warningThresholds": [],
    "allocationKey": "optional-task-or-cost-center"
  },
  "actors": [],
  "observations": [],
  "verification": [],
  "disposition": {},
  "outcomes": [],
  "costs": [],
  "verdict": {
    "state": "PASS|FAIL|INCONCLUSIVE",
    "policyId": "name@version",
    "findingIds": []
  },
  "integrity": {
    "eventRoot": "sha256:...",
    "receiptHash": "sha256:...",
    "signature": "optional-sigstore-or-dsse-reference"
  }
}
```

## Evidence types

### Authority

Record the human task boundary independently of a runtime permission setting.
Approval lifecycle values are `requested`, `approved`, `rejected`,
`agent_cancelled`, `expired`, and `transport_lost`. They must not collapse into
a boolean.

Delegated episodes inherit no more authority than their parent. Any expansion
requires a new human or policy authorization observation.

### Actions

Each material observation has a source adapter, source version, monotonic
sequence, wall-clock timestamp, action class, target hash, result, and raw
evidence hash. Material classes include file mutation, shell execution,
dependency change, network access, external write, deployment, release,
credential access, and task delegation.

Adapter output is untrusted until normalized and policy-evaluated. Agent
self-report is a claim source, never independent verification.

### Verification

Verification binds the exact command, working directory, environment digest,
exit status, observed test counts, relevant artifact hashes, and head SHA.
Freshness and SHA binding are mandatory policy inputs. Claimed and observed
counts remain separate.

### Maintainer disposition

For every finding, retain `accepted`, `dismissed`, `superseded`, or
`unreviewed`, along with actor, time, and optional reason code. For the change,
retain review start/end, requested changes, merge/close state, and the human
review minutes only when directly captured or explicitly entered.

### Downstream outcome

Outcome events are append-only and may arrive after episode closure:
`merged`, `reverted`, `hotfixed`, `escaped_defect`, `incident_linked`, and
`no_known_event_through`. The last value requires a through-date and must not
be described as proof of no defect.

### Cost

Cost entries identify currency, amount, unit, time window, allocation method,
and source. Measured API or platform cost, estimated human review cost, and
modeled avoided cost are different types. Net value is `INCONCLUSIVE` when the
baseline or allocation method is absent.

A task budget is established before execution and remains distinct from
observed cost. Early adapters may emit warnings only. Hard interruption must
not be enabled until the adapter proves that delayed, cached, retried, and
parallel usage is attributed reliably without undercounting committed spend.

## Privacy tiers

- `receipt`: hashes, counts, verdicts, policy identity, code SHAs, and evidence
  completeness only; no prompts, paths, commands, or source content.
- `metadata`: receipt plus normalized action classes, timings, tool identities,
  command digests, and redacted paths.
- `full-local`: raw evidence may remain on the user's machine; exports still
  follow an explicit redaction policy.

No tier uploads evidence by default. Repository names, user identities, prompt
text, source text, credentials, and environment values are excluded from a
public receipt unless separately opted in.

## Integrity and portability

Events form a canonical ordered Merkle chain. Closure records the root, policy
version, normalizer versions, and receipt hash. Implementations should support
DSSE/Sigstore-compatible signing without making signature availability a
requirement for local use.

Compatibility reference: the
[DSSE protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
defines the envelope and pre-authentication encoding. It provides payload
integrity, not Agent Vigil's evidence semantics or verification policy.

The conformance suite must include altered-event, reordered-event,
cross-commit-replay, stale-test, forged-agent-claim, missing-parent-authority,
and privacy-redaction fixtures.

## Non-goals for v1

- storing a full transcript service;
- scoring developer productivity from generated lines or tool-call volume;
- asserting causation from a later incident without a recorded linkage basis;
- replacing runtime sandboxes, code review, SAST, or human approval;
- assigning an ROI number when baseline evidence is missing.

## Implementation gate

The schema becomes stable only after three independent adapters can emit it,
the same receipt verifies on macOS and Linux, privacy fixtures prove excluded
content is absent, and one downstream merge/revert event can be appended
without changing the original episode root.

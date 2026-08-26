# Guarded-host continuity

`vigil continuity guard-demo` joins two separate checks:

1. The supplied Claude Code and Codex receipts show that each host routed harmless live tool calls through the
   temporary Agent Vigil control.
2. Continuity kept a later control failure effective until a different trusted
   verifier signed an exact repair.

The command requires one passing Claude route receipt and one passing Codex
route receipt from the same operating-system and machine binding. It validates
the recorded versions and executable hashes; it does not query either vendor to
decide whether those versions are still current:

```bash
vigil continuity guard-demo \
  --claude-route claude-live-route.json \
  --codex-route codex-live-route.json \
  --output guarded-host-continuity.json
```

It produces this sequence:

1. Both current host routes pass, so the demonstration reaches `CURRENT`.
2. A controlled fail-open fixture records `REVOKED` and stops deployment.
3. A later ordinary passing route leaves the result `REVOKED`.
4. Independent signed repair of that exact revocation restores `CURRENT`.

The complete five-event history remains visible. Every event is signed inside
the temporary demonstration, and the repair signer is different from the
signer that recorded the failure.

## Receipt checks

Before adding a host receipt to the history, Agent Vigil checks:

- the complete fixed schema and receipt hash;
- the exact host version and executable hash;
- the host invocation, challenge pack, temporary control, policy, and
  configuration hashes;
- the operating system, architecture, and privacy-reduced machine identity;
- the allow and deny call results, call identifiers, and shared host session;
- the route summary, cleanup result, deployment reasons, and next gate.

A passing receipt becomes fresh affirmative evidence. A contradictory receipt
becomes a revocation. An inconclusive receipt becomes a coverage gap and
therefore `HOLD`. A supplied expected binding that does not match becomes a
revocation instead of being treated as a new passing configuration.

The continuity event retains only the source category, receipt hash, binding
hash, times, and fixed reason. It does not copy host output, prompts, commands,
paths, profile contents, or credentials.

## What this demonstration proves

It proves the state machine for two supplied reduced receipts:

- both sources are required;
- later contradictory evidence is sticky;
- an ordinary green result cannot erase a revocation; and
- only a fresh, trusted, independently signed repair can close the exact
  revocation.

The failure is deliberately manufactured inside the local demonstration. It
is not a real Claude failure, Codex failure, security incident, deployment
stop, outside installation, payment, or revenue event.

The route receipts are locally integrity-hashed, not independently
authenticated attestations. The trusted continuity signer takes responsibility
for accepting and recording them. Production use still needs protected signing
keys, reviewed policy, a separately authorized deployment gate, and evidence
from the exact production hosts.

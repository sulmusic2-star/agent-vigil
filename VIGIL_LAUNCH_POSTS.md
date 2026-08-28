# Agent Vigil v0.21.2 launch copy

Prepared August 28, 2026. Not posted.

## GitHub launch demonstration

A coding-agent change can pass every check at merge time and become unsafe
later. Agent Vigil keeps the evidence history and changes deployment permission
when later evidence contradicts the original result.

The harmless continuity demonstration is deterministic:

1. The reviewed change passes.
2. Fresh merge and verification evidence make it `CURRENT`.
3. A verified revert makes it `REVOKED` and blocks deployment.
4. A later ordinary green check cannot erase the revocation.
5. Independent signed remediation aimed at that revocation restores `CURRENT`.

Run the proof locally. It deploys nothing:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.2/sulmusic-agent-vigil-0.21.2.tgz \
  continuity demo --json
```

Install the repository gate:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.2/sulmusic-agent-vigil-0.21.2.tgz \
  protect --action-sha 33ae20140ffb2e25a034f291225849765ff8d217

# Review and commit the generated controls, then verify the installed state.
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.2/sulmusic-agent-vigil-0.21.2.tgz \
  doctor
```

Repository: https://github.com/sulmusic2-star/agent-vigil

Release: https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.21.2

No source, prompts, or transcripts are uploaded. The demonstration proves the
mechanism only. It does not prove outside adoption, a real production stop,
payment, or revenue.

## Short version

Agent Vigil remembers when a previously trusted coding-agent change is later
reverted or contradicted. Deployment moves from `CURRENT` to `REVOKED`, stays
revoked through an ordinary green check, and returns to `CURRENT` only after
independent signed remediation.

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.2/sulmusic-agent-vigil-0.21.2.tgz \
  continuity demo --json
```

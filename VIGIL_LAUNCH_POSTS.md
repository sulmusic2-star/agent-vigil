# Agent Vigil v0.22.0 launch copy

Prepared August 28, 2026. Not posted.

## Browser-first public launch

**Title:** Show HN: Check the public evidence behind a coding-agent PR without installing anything

Paste a public GitHub pull request into:

https://sulmusic2-star.github.io/agent-vigil/check.html

Agent Vigil reads public pull-request, review, check-run, and commit-status
metadata. It returns `CURRENT`, `HOLD`, `EXPIRED`, or `REVOKED`, with exact base
and head commits and a downloadable receipt. It asks for no login or token,
fetches no source code, and writes nothing to the repository.

The page is deliberately conservative. A green public record does not prove
that the tests were sufficient and never authorizes a merge or deployment.

If the result is useful, the page copies the exact v0.22.0 local setup steps.
The current hosted workflow supports a root Node/npm repository with a direct
`node --test` command. Unsupported repository shapes fail closed.

Source: https://github.com/sulmusic2-star/agent-vigil

I am measuring configured outside workflows and repeat runs separately from
page views, clones, stars, mentions, payments, and revenue. The starting count
of verified outside installations is zero.

**Short post:**

Paste a public coding-agent PR into Agent Vigil. It checks the public reviews,
checks, exact commits, and missing evidence without a login, token, source
upload, or repository write. The result never authorizes merge or deployment.

https://sulmusic2-star.github.io/agent-vigil/check.html

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
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  continuity demo --json
```

Install the repository gate from a Node/npm repository whose test script is a
direct Node test command such as `node --test test/*.test.js`:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  protect

# Review and commit the generated controls, then verify the installed state.
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  doctor
```

If Agent Vigil cannot infer that safe hosted command, it leaves a visible
placeholder and `doctor` fails closed.

Repository: https://github.com/sulmusic2-star/agent-vigil

Release: https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.22.0

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
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  continuity demo --json
```

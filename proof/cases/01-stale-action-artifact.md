# Case 01: stale Action artifact produced a false PASS

## What was claimed

The v0.4 release candidate reported 133 passing tests, a local self-audit PASS,
and hardened Action error handling in the public [PR #6 description](https://github.com/sulmusic2-star/agent-vigil/pull/6).

## What the gate caught

Hosted Linux CI invoked the Action once with valid evidence and then with
malformed JSONL. The second invocation read `agent-vigil-report.json` left by
the first and returned its stale `PASS` instead of `INCONCLUSIVE`.

- Candidate: `cadf7d4243c8c923858ea19f76bc018d9ed77cd4`
- Baseline: `066f03e4362daee90483baf1db824af0269e661c`
- Failed hosted run: [32413169909](https://github.com/sulmusic2-star/agent-vigil/actions/runs/32413169909)
- Corrective commit: `3a581e8a19e113922e82cda93fefdde41c6d1422`
- Passing hosted run: [32415457705](https://github.com/sulmusic2-star/agent-vigil/actions/runs/32415457705)

## Maintainer disposition

Release blocked. Each Action invocation was moved to a fresh runner-temporary
directory. The documented root artifacts are copied only from that invocation's
result.

## Corrected result

The same valid-then-malformed negative control reports `INCONCLUSIVE` for the
malformed input. Linux Node 20/22/24, macOS, and Windows all passed before
v0.4.0 was tagged.

## Limit

This case proves isolation for the tested Action path. It does not prove that
every third-party workflow stores or names artifacts safely.

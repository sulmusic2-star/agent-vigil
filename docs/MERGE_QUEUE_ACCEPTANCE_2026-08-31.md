# Merge-queue acceptance — 2026-08-31

This is a first-party deployment test. It proves that the checked-in design can
enforce a real GitHub merge queue after the fixes on the release branch are
merged. It does not count as external adoption, retained use, payment, or
revenue.

## Live boundary

- Repository: [`agent-vigil/merge-queue-lab`](https://github.com/agent-vigil/merge-queue-lab)
- Ruleset: [`21935493`](https://github.com/agent-vigil/merge-queue-lab/rules/21935493)
- Required check: `Agent Vigil governed evidence`, bound to GitHub App ID
  `4781874`
- App: `agent-vigil-queue-gate-runtime`, installed only on the lab repository
- Worker: `agent-vigil-merge-queue-lab`, version
  `30954ac8-4ba1-45d3-ba81-a6bebfdb89f8`, deployed from merged commit
  `d1020ceab9f1d8fa3dcaafccd62d6d713e744b69`
- Protected environment: `agent-vigil-gate`, restricted to `main`

No credential value is recorded in this repository.

The environment restriction rejected a non-`main` branch before any step ran
in [Actions run 33402438414](https://github.com/agent-vigil/merge-queue-lab/actions/runs/33402438414).
The deployed Worker returned HTTP 401 for an unsigned webhook request.

## Defect found during the live test

GitHub's App manifest flow returned an RSA PKCS#1 private key. The v0.23.3
Worker accepted only PKCS#8, so the first signed `merge_group` delivery failed
before token creation. The Worker now converts either unencrypted RSA PKCS#1 or
PKCS#8 to importable PKCS#8 bytes in memory. A generated-key regression test
imports and signs with both formats.

The live test also exposed two portability faults in the protected workflows:

1. the pull-request App-token job was scoped to the literal repository name
   `agent-vigil`; and
2. the queue workflow required the literal actor
   `agent-vigil-gate[bot]`, although GitHub App names are globally unique.

The corrected workflow scopes the token to
`${{ github.event.repository.name }}` and reads the exact bot login from the
protected `AGENT_VIGIL_GATE_ACTOR` environment variable, with the manifest's
default actor as a fallback.

## Passing composition

[Pull request 4](https://github.com/agent-vigil/merge-queue-lab/pull/4) passed
the ordinary exact-head verifier and the App-bound pull-request check in
[Actions run 33407419424](https://github.com/agent-vigil/merge-queue-lab/actions/runs/33407419424).
Its pull-request head was
`c580e53f980dc186e86eb0b70bdad3cd7756d526`.

GitHub composed queue head
`9d5d6877d3174cd28657f8c00e1abcda5157ecf2`. The external Worker dispatched
[Actions run 33407529923](https://github.com/agent-vigil/merge-queue-lab/actions/runs/33407529923).
The isolated queue verification passed, and App ID `4781874` published a
successful `Agent Vigil governed evidence` check for that exact SHA. GitHub
merged the pull request as the same commit at 2026-08-31T15:18:10Z.

No temporary sentinel status was used for pull request 4.

## Failing composition

[Pull request 5](https://github.com/agent-vigil/merge-queue-lab/pull/5) first
passed its ordinary and App-bound pull-request checks against base
`9d5d6877d3174cd28657f8c00e1abcda5157ecf2` in
[Actions run 33407818829](https://github.com/agent-vigil/merge-queue-lab/actions/runs/33407818829).
Its head was `b675fe87d01f1bc1f6dafdce09bb6c4609f2084a`.

An independent passing change then advanced `main` to
`513892812a5806850b9f9a7bfe36a1c55429557f`. GitHub composed the stale
candidate as queue head
`d3571ebcd80f3afae6c7a03ad361db6019ba8a8f`. The earlier pull-request checks
were still green, but the new composition made one test fail.

[Actions run 33408307891](https://github.com/agent-vigil/merge-queue-lab/actions/runs/33408307891)
reported `FAIL`. App ID `4781874` published a failing
`Agent Vigil governed evidence` check for the exact queue SHA, with external
identity
`merge-group:20fe9d00-a550-11f1-9c65-5d482ed3ee25:d3571ebcd80f3afae6c7a03ad361db6019ba8a8f`.
The retained receipt is
`sha256:f1b329d280a402720c60fc42150d8eae16f7272dd60f8e5be2fbccb51c341f70`.
GitHub removed the candidate from the queue and left the pull request open and
unmerged.

## Bootstrap disclosure

[Pull request 3](https://github.com/agent-vigil/merge-queue-lab/pull/3)
installed the App-bound pull-request job. Agent Vigil correctly failed that
pull request because it changed protected workflow paths. A temporary
`Agent Vigil bootstrap sentinel` was applied to the pull-request head and its
queue head for this one protected-control installation. The pull-request body
disclosed the exception. The sentinel was then removed from the active
ruleset and replaced by the App-bound required check.

This bootstrap does not count as a normal passing verdict. Pull requests 4 and
5 are the post-bootstrap acceptance cases.

## Merged-source check

Pull request 151 merged as
`d1020ceab9f1d8fa3dcaafccd62d6d713e744b69`. Its tree is byte-identical to
the reviewed head. [Main-branch CI run 33410193694](https://github.com/sulmusic2-star/agent-vigil/actions/runs/33410193694)
passed Node 20, Node 22, Node 24, macOS 14, Windows 2022, the packed-package
rehearsal, and the Docker isolation regression. [CodeQL run 33410193746](https://github.com/sulmusic2-star/agent-vigil/actions/runs/33410193746)
passed with zero open alerts.

The Worker was then redeployed from that exact merged tree. Its health route
returned HTTP 200, and an unsigned webhook request returned HTTP 401.

## Remaining gates

- Release a fresh packed artifact. The deployed lab contains fixes newer than
  the current v0.23.3 tag.
- Keep the App-bound ruleset active and recheck the lab after release.
- Obtain retained use in an independently owned repository. This lab is owned
  by the project and is not external adoption.
- Verify npm and GitHub release parity separately before claiming the release
  is distributed.

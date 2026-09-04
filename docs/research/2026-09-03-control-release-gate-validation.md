# Control release gate validation — 3 September 2026

## Decision

Continue with a narrow product: **an independent release gate for AI-agent controls**.

The job is simple to state:

> Do not promote an agent, policy, or control update unless an independent run proves the required allow and deny behavior, and the approval matches the exact package, commit, environment, and deployment.

This is not another code reviewer or general agent-security dashboard. It is the last independent decision before an AI-control update reaches a protected environment.

## What the candidate adds

The candidate can now:

- issue a short-lived signed challenge;
- observe allowed and forbidden effects outside the candidate process;
- compare current and candidate control routes in the same recorded environment;
- require distinct admission and deployment signers;
- bind approval to one repository, commit, GitHub environment, artifact digest, and environment digest;
- register that approval with the hosted App over an authenticated request;
- approve or reject a GitHub deployment protection request;
- re-hash the downloaded artifact before the protected job uses it.

The hosted decision and the byte check are separate on purpose. App approval alone is not represented as proof of the downloaded package.

## Security correction

A first security scan found that the hosted registration endpoint trusted the outer deployment authorization without independently reopening the linked admission. That collapsed the intended two-signer boundary.

The endpoint now verifies both signed envelopes with separate pinned Ed25519 keys and checks their exact linkage before storage. It also requires a domain-separated HMAC over the exact request body, rejects stale authorizations, bounds request and response bodies, requires JSON content types, validates callback identities, and expires Durable Object state by alarm.

A fresh immutable scan is still required after the candidate is committed. The earlier scan proves the defect was found, not that the final commit is clean.

## Benchmark results

The release gate is bound to the competitor corpus at commit `b2b681ff529929d39a14c0541d0e2b71b642b5da`, including exact Git tree IDs for both corpus directories.

The frozen gate passes:

- 220/220 scoped planted failures caught in the oracle corpus;
- 0/1 targeted false positives on the negative control;
- 99/232 presumed-clean pull requests received at least one advisory;
- 9/232 raw diffs failed closed because evidence was incomplete;
- 4/4 arbiter-labelled cases received an advisory, with 2/4 exact-category matches.

Noise work reduced assertion-loss advisories from 22 pull requests to 7 by avoiding a duplicate when a test-count loss already states the stronger fact. Generated source maps and nested vendored code are now outside the static detector's scope. The total advisory reach fell from 104/232 to 99/232 without weakening the 220/220 frozen catch gate.

The non-blind comparison against Swarm has no predetermined winner:

| Dataset | Agent Vigil | Swarm |
|---|---:|---:|
| 520 paired synthetic cases: balanced accuracy | 88.5% | 64.4% |
| 325 constructive injections: exact category | 75.1% | 79.4% |
| 232 presumed-clean PRs: PRs with advisories | 42.7% | 30.6% |
| 232 presumed-clean PRs: total findings | 127 | 622 |
| 10 strict real complaint PRs: any finding | 0 | 2 |

The constructive-injection exact-category difference was not statistically significant (`p=0.188847`). Agent Vigil produced far fewer individual findings, but touched more presumed-clean pull requests. Both tools missed every exact category in the strict real-complaint slice. Those losses are product evidence, not results to hide.

## Current verification state

- TypeScript typecheck: passed.
- Build: passed.
- Hosted App tests: 66/66 passed.
- Frozen benchmark gate: passed.
- Focused detector tests: passed.
- Cloudflare staging dry run: passed; no Worker was deployed.
- Full suite: one expected release-identity failure remains while source and `dist/cli.js` differ from the previously reviewed commit. That failure must remain until release assembly pins a new exact commit.

## What this does not prove

No Worker has been deployed from this candidate. The GitHub App permission expansion is not active. No real deployment protection rule has accepted and rejected a disposable deployment. No outside organization has retained the gate. No customer has paid or renewed.

The code supports a serious pilot. It does not prove production readiness, market superiority, or likely multimillion-dollar revenue.

## Required next proof

1. Commit the candidate and run a fresh immutable security review against that exact commit.
2. Reconcile it through reviewable pull requests without bypassing the repository's protected-path policy.
3. Assemble a new release identity; do not reuse v0.23.4.
4. Test the packed artifact on Linux, macOS, Windows, Docker, and the hosted Action.
5. Deploy the Worker and activate the App permissions in a disposable environment.
6. Prove one authorized deployment passes and missing, stale, wrong-commit, wrong-environment, wrong-key, and wrong-byte deployments reject.
7. Seek outside installations only after that live cycle is reproducible.

The commercial gate is repeated outside use: a team keeps the protection rule enabled for a second release and can name a release or audit decision it made better. Payment and renewal come after that, not from test counts.

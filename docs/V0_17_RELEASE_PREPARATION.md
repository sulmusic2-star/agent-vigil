# v0.17.0 immutable release preparation

This runbook separates source preparation from publication. The release-code
work starts from exact commit
`216394ef73cc58f957c601ec34eb58eda3ccd937`. A stable version in
`package.json`, a rebuilt bundle, or a passing local gate does not prove that a
tag, release asset, npm package, Marketplace listing, required workflow, Pages
site, or hosted service is live.

## Two-commit source boundary

1. Create and review one release-code commit. It contains version `0.17.0`, the
   deterministic `dist/cli.js`, public semver examples, and release wording.
   Record its exact 40-character commit ID after creating it; a commit cannot
   contain its own identity.
2. Create one pin-only successor. Replace the self-Action references in these
   three high-trust files with that exact release-code commit ID:

   - `.github/workflows/agent-vigil.yml`;
   - `.github/workflows/agent-vigil-outcomes.yml`; and
   - `examples/upgrade-guard/github-workflow.yml`.

   Update the release-hygiene assertion in the same pin-only commit so those
   references must be exact 40-character SHAs. Do not permit a tag, branch, or
   floating ref in any of those three files.
3. Re-run the full release gate on the pin-only successor, verify that the
   committed bundle is unchanged by a clean rebuild, then obtain an independent
   security decision against that exact final SHA. Any edit after the decision
   invalidates it.
4. Only after a bounded `GO` may an operator deliberately push the reviewed
   commits, create the immutable `v0.17.0` tag, publish a non-prerelease GitHub
   release, and verify every asset and consumer surface independently. npm,
   Marketplace, Pages, rulesets, GitHub App, Cloudflare, Stripe, and other
   provider states remain separate operations and separate evidence.

The generic `v0.17.0` examples name the intended release coordinate. They do
not resolve until that release is actually present and independently verified.
The prior confirmed public v0.16.0 release contains signed-control proof, not
the automatic APM or hosted-service surfaces prepared here.

## Commercial and measurement boundary

This preparation does not deploy the disabled proof-network or Team services
and does not connect billing, GitHub App, or measurement providers. Verified
external adoption, paid organizations, recognized MRR, and revenue are zero.
R0 has not started. It starts only after the independently reviewed release is
live, opt-in lifecycle measurement is operational, and the commercial name
gate is cleared. Do not infer demand from the committed corpus, local tests,
release artifacts, or provider configuration placeholders.

This document authorizes no GitHub setting change, required-workflow install,
tag, release, package publication, deployment, billing action, refund, message,
or advertising spend.

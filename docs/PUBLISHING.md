# Publishing runbook

Distribution states are verified independently. A GitHub release does not make
the npm package or Marketplace listing live.

## Release gate

```bash
npm ci
npm run check
npm run review:public
npm run test:coverage
npm run test:package
npm run proof:historical
npm pack --dry-run --json
npm audit
```

Create the release from the exact tested commit. Attach the generated npm
tarball, its SHA-256 checksum, and `proof/results.json`.

## npm

The package stages from `.github/workflows/publish.yml` through npm trusted
publishing. Verification and packing must run in a job with no OIDC or registry
write authority. A separate minimal staging job receives only the hash-bound
tarball, verifies its digest and version with lifecycle scripts disabled, and
then obtains GitHub's short-lived OIDC identity for `npm stage publish`.
Repository code must not execute after that job receives staging authority. The
workflow stores no npm write token and requires npm 11.15.0 or newer in both
jobs. The package manifest and staging command both require provenance; npm
also generates provenance automatically for this public-package, public-repo
trusted-publishing path. Configure the npm package with these exact values:

- provider: GitHub Actions;
- organization or user: `sulmusic2-star`;
- repository: `agent-vigil`;
- workflow filename: `publish.yml`;
- environment: `npm-publish`, restricted in GitHub to protected release tags;
- allowed action: `npm stage publish` only; disable direct `npm publish`.

The workflow runs only when a stable GitHub release is published. After an
ambiguous staging failure, inspect npm's staged-package queue before rerunning;
rerun the same release workflow only when that exact version is absent. There
is no branch-selectable manual staging trigger. The workflow checks out the
release event's exact commit, requires the package version to match, runs the
release checks, and compares package integrity before accepting an
already-published version. For a previously unpublished version, successful
workflow completion means the package is staged, not public. Review the staged
metadata and tarball, then approve it separately with 2FA. A matching version
that is already public is reported as a no-op. After npm promotion and
publish-time scanning complete, verify the public registry integrity and
consumer path below.

Agent Vigil declares npm's `dual-use` content class because it is a defensive
security utility with command-inspection and controlled-execution features.
The root `DISCLOSURE` file and `package.json` declaration must remain present in
every later package version unless npm Trust & Safety approves their removal.

Verify each release independently. The v0.21.1 registry commands below are
expected to fail until that version completes npm publication:

```bash
npm whoami
npm view @sulmusic/agent-vigil version dist-tags.latest
npm view @sulmusic/agent-vigil@0.21.1 dist.integrity
npx --yes @sulmusic/agent-vigil@0.21.1 doctor
```

The canonical npm name is scoped because npm rejected the unscoped
`agent-vigil` name as too similar to the existing, separate `agentvigil`
package. Do not publish or document the other package as Agent Vigil.

After the OIDC path succeeds, remove unused long-lived registry write tokens.
Never call a registry release live until `npm view`, integrity comparison, and
a clean `npx` consumer run all succeed.

## GitHub Marketplace

Prepared listing metadata:

- name: `Agent Vigil`;
- description: `Fail-closed change control and evidence receipts for AI coding agents`;
- primary category: Code quality;
- secondary category: AI Assisted;
- branding: shield / green;
- source metadata: root `action.yml`;
- release: `v0.11.2` or newer.

The public listing is `https://github.com/marketplace/actions/agent-vigil`.
Confirm every release through that listing and the exact Marketplace search;
do not infer publication from a release checkbox.

## GitHub Pages

The static site lives in `docs/`. Configure Pages to deploy `main:/docs`, wait
for a successful build, then verify the public URL and repository homepage.
The install page should show the exact npm version confirmed by both `npm view`
and a clean `npx` consumer run.

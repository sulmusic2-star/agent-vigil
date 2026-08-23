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

The package publishes from `.github/workflows/publish.yml` through npm trusted
publishing. The workflow uses GitHub's short-lived OIDC identity; it does not
store an npm write token. Configure the npm package with these exact values:

- provider: GitHub Actions;
- organization or user: `sulmusic2-star`;
- repository: `agent-vigil`;
- workflow filename: `publish.yml`;
- allowed action: `npm publish`.

The workflow normally runs when a stable GitHub release is published. Use its
manual `tag` input only to publish an existing release whose registry step was
missed. It checks out that exact tag, requires the package version to match,
runs the release checks, and compares package integrity before accepting an
already-published version.

Verify each release independently:

```bash
npm whoami
npm view @sulmusic/agent-vigil version dist-tags.latest
npm view @sulmusic/agent-vigil@0.14.0 dist.integrity
npx --yes @sulmusic/agent-vigil@0.14.0 doctor
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

# Publishing runbook

Distribution states are verified independently. A GitHub release does not make
the npm package or Marketplace listing live.

## Release gate

```bash
npm ci
npm run check
npm run test:coverage
npm run test:package
npm run proof:historical
npm pack --dry-run --json
npm audit
```

Create the release from the exact tested commit. Attach the generated npm
tarball, its SHA-256 checksum, and `proof/results.json`.

## npm

The initial publication needs an authenticated npm owner:

```bash
npm login
npm whoami
npm publish --access public --provenance
npm view agent-vigil version dist-tags.latest
npx --yes agent-vigil@0.10.1 doctor
```

After the package exists, configure an npm trusted publisher for the release
workflow, publish through OIDC, and remove long-lived registry tokens. Never
call the registry route live until `npm view` and a clean `npx` consumer run
both succeed.

## GitHub Marketplace

Prepared listing metadata:

- name: `Agent Vigil`;
- description: `Fail-closed evidence receipt for AI coding-agent sessions`;
- primary category: Code quality;
- secondary category: Testing;
- branding: shield / green;
- source metadata: root `action.yml`;
- release: `v0.10.1`.

GitHub requires the publisher to accept the Marketplace Developer Agreement
and complete the 2FA-protected publication flow. Those account and legal steps
must be performed by the owner. Confirm publication with the exact Marketplace
search and the listing URL; do not infer it from a release checkbox.

## GitHub Pages

The static site lives in `docs/`. Configure Pages to deploy `main:/docs`, wait
for a successful build, then verify the public URL and repository homepage.
The install page must continue to show the GitHub package command until npm is
confirmed live.

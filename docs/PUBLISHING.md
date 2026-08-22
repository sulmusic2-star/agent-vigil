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
npm publish --access public
npm view @sulmusic/agent-vigil version dist-tags.latest
npx --yes @sulmusic/agent-vigil@0.11.3 doctor
```

The canonical npm name is scoped because npm rejected the unscoped
`agent-vigil` name as too similar to the existing, separate `agentvigil`
package. Do not publish or document the other package as Agent Vigil.

After the package exists, configure an npm trusted publisher for the release
workflow, publish through OIDC, and remove long-lived registry tokens. Never
call the registry route live until `npm view` and a clean `npx` consumer run
both succeed.

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

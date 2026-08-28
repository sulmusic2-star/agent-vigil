# Run the proof in under a minute

This check installs Agent Vigil in a disposable repository, inspects the
base-selected workflow and its immutable Action pins, runs `vigil doctor`, and
replays the three published historical failures. It stops after 60 seconds
rather than turning a slow or stuck command into a pass.

From an Agent Vigil checkout:

```bash
npm ci
npm run build
npm run demo:60s
```

For machine-readable output:

```bash
npm run demo:60s -- --json
```

A passing run proves that the current checkout can:

- install its base-selected pull-request check in a clean repository;
- pin the Agent Vigil Action to the exact reviewed checkout commit;
- retain an `agent-vigil-receipt` artifact;
- diagnose the generated setup; and
- reproduce all three cases in the [public failure corpus](../proof/README.md).

The temporary repository is deleted after the run. The historical cases are
first-party records from this project. This demo does not count as an outside
installation, retained use, payment, or revenue.

To report a real trial, use the
[adopter evidence form](https://github.com/sulmusic2-star/agent-vigil/issues/new?template=adopter-feedback.yml).

# Agent Upgrade Guard

Agent Upgrade Guard answers one bounded question before an update is installed:

> Did this exact candidate artifact materially change the observations produced
> by these exact local canaries, compared with this exact current artifact?

It inspects both artifact directories, runs the same trusted canaries against
each one in a network-disabled Docker container, and returns one of three
verdicts:

| Verdict | Meaning | Exit code |
|---|---|---:|
| `SAFE` | Every required control held, every repeated canary was stable, and no configured capability or canary observation changed. | `0` |
| `CHANGED` | Complete comparable evidence exists and at least one configured capability or canary observation changed. The update remains blocked for review. | `1` |
| `HOLD` | The comparison is not trustworthy because identity, containment, baseline health, completeness, or repeatability evidence is missing. | `2` |

`SAFE` is deliberately narrow. It means **no material change was detected by
the configured canaries under the recorded contained runner**. It does not mean
that the candidate is universally safe, semantically correct, free of
vulnerabilities, or compatible with behavior that the canaries did not exercise.

## Current scope

This first version is a local, offline compatibility gate for bounded component
directories with JSON manifests. Typical candidates include a packaged plugin,
skill bundle, MCP server, agent extension, or another dependency whose current
and candidate trees can be materialized separately.

It does not install the candidate into the user's active agent stack. The old
version remains untouched because both versions are mounted read-only for the
comparison. It also does not upload a receipt or publish an index entry.

Live model and provider behavior is outside this lane. The runner has no network
access and receives no provider credentials. Mutable model aliases such as
`latest`, authentication behavior, hosted service changes, and production
latency therefore cannot be established by an Upgrade Guard verdict.

## Requirements

- Node.js 20 or newer for Agent Vigil.
- A running Docker-compatible daemon.
- For `init` and `doctor`, `--repo` must name the exact root of a Git
  repository, not a parent or nested directory.
- A trusted runner image already present locally and named by an immutable
  `@sha256:` digest. Upgrade Guard uses `--pull=never`.
- The runner image must contain `node`, which the containment preflight uses.
- Pairwise separate, non-overlapping current, candidate, and trusted canary
  directories containing regular files only.

Each artifact directory is limited to 4,096 files, 4 MiB per file, and 64 MiB
in total. Symbolic links and non-regular filesystem entries are refused. The
component manifest must be valid JSON, remain inside its artifact directory,
and match the configured component identity.

## Commands

Initialize the local scaffold:

```bash
vigil upgrade init --repo .
```

The default configuration is `.agent-vigil/upgrade/config.json`. The generated
canary intentionally reports `FAIL`; it is a template that cannot earn `SAFE`
until it is replaced with a real behavioral canary. Review both files before
trusting them. Existing scaffold files are preserved unless `--force` is
supplied; `--force` replaces the generated configuration, template canary, and
private-directory ignore file. Then check the local environment and containment
preflight without running candidate canaries:

```bash
vigil upgrade doctor --repo .
```

Compare two already-materialized artifact directories:

```bash
vigil upgrade check \
  --repo . \
  --current ./artifacts/plugin-current \
  --candidate ./artifacts/plugin-candidate
```

The default private receipt path is
`.agent-vigil/upgrade/last-receipt.json`. Use `--output` to select another
private path. The configuration and private receipt paths must remain inside
`--repo`; current and candidate artifact directories may be elsewhere:

```bash
vigil upgrade check \
  --repo . \
  --current ./artifacts/plugin-current \
  --candidate ./artifacts/plugin-candidate \
  --output ./.agent-vigil/upgrade/private-receipt.json
```

An explicit configuration path can be supplied when the default scaffold is
not used:

```bash
vigil upgrade doctor --repo . --config .agent-vigil/upgrade/config.json

vigil upgrade check \
  --repo . \
  --config .agent-vigil/upgrade/config.json \
  --current ./artifacts/plugin-current \
  --candidate ./artifacts/plugin-candidate \
  --output ./.agent-vigil/upgrade/private-receipt.json
```

The private receipt is written locally. Creating the smaller public entry is a
separate, explicit operation and requires an Ed25519 signing key:

```bash
vigil keygen \
  --private ~/.config/agent-vigil/compatibility-private.pem \
  --public ~/.config/agent-vigil/compatibility-public.pem

vigil upgrade check \
  --repo . \
  --current ./artifacts/plugin-current \
  --candidate ./artifacts/plugin-candidate \
  --output ./.agent-vigil/upgrade/private-receipt.json \
  --public-output ./compatibility-entry.json \
  --signing-key ~/.config/agent-vigil/compatibility-private.pem
```

Writing `compatibility-entry.json` does not submit or publish it. Review the
file before placing it in a repository, issue, website, or compatibility index.
An embedded signing key proves only that the corresponding private key signed
the entry. Pin the public key through an independent trusted channel when signer
identity matters.

Receipt and index outputs may not alias the configuration, signing key, pinned
public key, source entry, or one another. Check outputs are also refused inside
the current, candidate, or canary trees so writing evidence cannot mutate the
inputs it describes.

Verify a public entry's canonical hash and embedded signature:

```bash
vigil upgrade verify ./compatibility-entry.json
```

Pin signer identity to a separately obtained public key when that distinction
matters:

```bash
vigil upgrade verify \
  ./compatibility-entry.json \
  --public-key ~/.config/agent-vigil/compatibility-public.pem
```

Build a standalone local index from one or more public entries:

```bash
vigil upgrade index \
  ./compatibility-entry.json \
  ./another-compatibility-entry.json \
  --output ./agent-compatibility-index.html \
  --public-key ~/.config/agent-vigil/compatibility-public.pem
```

The index command verifies every entry before writing a local HTML artifact. It
does not host or publish it. `--public-key <path>` is required: every entry must
match that separately pinned signer key. `doctor` and `check` also accept
`--docker-bin <path>` for a compatible Docker client executable; this does not
change the required Docker engine or containment contract.

## Configuration

The complete contract is the
[Upgrade Guard configuration schema](upgrade-config-v1.schema.json). Unknown
fields are rejected.

```json
{
  "schemaVersion": "agent-vigil-upgrade-config/v1",
  "component": {
    "ecosystem": "npm",
    "name": "example-agent-plugin",
    "manifestPath": "package.json",
    "identityField": "name",
    "versionField": "version",
    "capabilityFields": ["bin", "scripts", "dependencies"]
  },
  "runner": {
    "engine": "docker",
    "image": "node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752",
    "trials": 2,
    "memoryMiB": 512,
    "cpus": 1,
    "pids": 64
  },
  "canaryDirectory": "examples/upgrade-guard/canaries",
  "canaries": [
    {
      "id": "manifest-shape-private",
      "publicId": "manifest-shape",
      "command": ["node", "manifest-shape.mjs"],
      "timeoutSeconds": 20
    }
  ]
}
```

`init` currently pins the exact runner image shown above. That image must
already be stored locally, and you must independently decide whether to trust
it before using its result. A mutable tag alone is never accepted.

### Component fields

- `ecosystem` and `name` identify the component. The manifest value selected by
  `identityField` must equal `name` in both artifact directories.
- `manifestPath` is a portable path relative to each artifact directory.
- `identityField`, `versionField`, and each `capabilityFields` value are dotted
  JSON paths such as `name`, `version`, or `contributes.commands`.
- The current and candidate versions must differ. Their full tree digests must
  also differ. An identical version or artifact is `HOLD`, not an update proof.
- Capability values are compared by canonical content hash. Their public entry
  is reduced to an allowlisted category such as `tools`, `hooks`, `mcpServers`,
  `permissions`, `skills`, `agents`, `commands`, or `dependencies`; other field
  names become `other`.

### Runner fields

- `image` must be an exact OCI image reference ending in `@sha256:` plus 64
  lowercase hexadecimal characters.
- `trials` is from 2 through 5. Every current and candidate trial must return the
  same state, observation hash, and observation count before it is comparable.
- `memoryMiB` is 128–4,096, `cpus` is 0.25–4, and `pids` is 16–512.

### Canary fields

- One through 32 canaries are allowed. Private `id` values must be unique.
- `publicId` is optional and opt-in. When omitted, the public entry carries only
  the SHA-256 digest of the private ID.
- `command` is an argv array, not a shell command. It contains 1–32 bounded
  strings and runs with `/canaries` as the working directory.
- `timeoutSeconds` is from 1 through 300.

## Canary contract

The same command is executed against the current and candidate directories.
Inside the container:

- `/target` is the selected artifact, mounted read-only;
- `/canaries` is the trusted canary directory, mounted read-only;
- the working directory is `/canaries`;
- `VIGIL_TARGET=/target`;
- `VIGIL_PHASE=current` or `VIGIL_PHASE=candidate`;
- network access is disabled; and
- proxy variables are explicitly cleared.

The command must exit zero and write exactly one bounded JSON document to
stdout. Diagnostic logging belongs on stderr. The document follows the
[canary output schema](upgrade-canary-v1.schema.json):

```json
{
  "schemaVersion": "agent-vigil-upgrade-canary/v1",
  "outcome": "PASS",
  "observations": {
    "entry.exists": true,
    "tool.count": 4,
    "protocol.version": "2026-06-18"
  }
}
```

`observations` must contain at least one and at most 64 fields. Keys are bounded identifiers;
values are bounded strings, finite numbers, booleans, or `null`. Arrays and
nested objects are intentionally unsupported. This keeps comparison
deterministic and limits accidental disclosure.

A current `FAIL` is not a healthy baseline and produces `HOLD`. A stable current
`PASS` followed by a stable candidate `FAIL` is comparable evidence of changed
behavior and produces `CHANGED`. A timeout, nonzero container exit, malformed
JSON, unstable repetition, or absent observation produces `HOLD`.

The repository contains a small
[manifest-shape example canary](../examples/upgrade-guard/canaries/manifest-shape.mjs).
It demonstrates the output contract; it is not sufficient coverage for a real
plugin or agent integration by itself.

## How the decision is made

Upgrade Guard first inventories both artifact trees and the trusted canary
harness. Each tree commitment covers ordered paths, byte counts, executable
mode bits, and file digests; no `.git` exception is made. It separately hashes
the loaded configuration, each manifest, and each configured capability value,
including whether that field was absent or explicitly `null`. It then runs a
planted containment preflight and the repeated canaries. All three trees are
re-inventoried afterward; any mutation or unreadable input returns `HOLD`.

The decision fails closed in this order:

1. If containment is not established, return `HOLD`.
2. If the component identities differ, return `HOLD`.
3. If the current, candidate, and canary roots overlap, or if versions or
   complete artifact tree hashes are identical, return `HOLD`.
4. If any current baseline is not a stable `PASS` with a nonempty observation,
   or any candidate result is
   incomplete or unstable, return `HOLD`.
5. If an artifact or canary tree changed during the run, return `HOLD`.
6. If a configured capability hash or comparable canary observation changes,
   return `CHANGED`.
7. Only otherwise return `SAFE`.

Duration, prose similarity, model judgment, and a command's unsupported claims
do not turn an incomplete run green.

## Docker containment boundary

Every probe and canary uses these controls:

- `--pull=never` and an exact image digest;
- `--network=none`;
- a read-only container root;
- read-only target and canary bind mounts;
- all Linux capabilities dropped;
- `no-new-privileges`;
- the invoking host's numeric non-root UID/GID when available, with a fixed
  unprivileged fallback;
- PID, memory, CPU, and wall-clock limits; and
- a bounded `noexec,nosuid,nodev` tmpfs at `/tmp`.

Before canaries run, a planted probe must confirm that the target mount and
container root reject writes, a direct network connection is blocked, a host
probe secret was not inherited, and Docker client proxy variables are empty.
Failure to establish any control is `HOLD`.

This is a containment boundary, not proof of harmless code. The Docker daemon,
host kernel or virtualization layer, exact runner image, and trusted canary
harness remain in the trusted computing base. A container escape or compromised
runner can invalidate the result. Do not mount the Docker socket, credentials,
package-manager configuration, cloud configuration, SSH material, or writable
host directories into the runner.

## Private and public evidence

The private receipt includes exact component identities, artifact, manifest,
configuration, and canary-harness hashes, capability field hashes, containment
results, private canary IDs, command commitments, repeated observation
commitments, decision reasons, and a random nonce. It omits raw artifact
contents and raw canary output, but it still
describes a private local evaluation and should be stored accordingly.
Its machine-readable contract is the
[private Upgrade Guard receipt schema](upgrade-receipt-v1.schema.json).

The signed public entry is derived from an intact private receipt. Its contract
is the [public compatibility entry schema](compatibility-entry-v1.schema.json).
It contains:

- component ecosystem, name, exact current and candidate versions, and artifact
  tree hashes;
- runner image, configuration, and canary-harness digests, trial count, and
  containment booleans;
- `SAFE`, `CHANGED`, or `HOLD`;
- allowlisted changed capability categories;
- optional opted-in canary public IDs, otherwise hashed private IDs;
- the private receipt commitment and explicit limitations; and
- a canonical entry hash and Ed25519 signature.

It excludes repository identity, local paths, commands, prompts, transcript
text, raw stdout or stderr, environment variables, file names, credentials, and
raw artifact contents. Privacy minimization does not make publication risk-free:
component names, version pairs, artifact hashes, optional `publicId` values, and
the signer key remain visible. Review every public entry before disclosure.

## What this does not prove

- That the canaries cover every meaningful behavior.
- That a `PASS` observation is a correct product requirement.
- That unchanged observations mean unchanged internal implementation.
- That a candidate is free of malicious behavior outside the exercised path.
- That the runner image, Docker daemon, kernel, or host is uncompromised.
- That live provider, model, identity, payment, deployment, or network behavior
  works.
- That an embedded signing key belongs to a particular person or organization.
- That a locally generated public entry has been submitted, accepted, indexed,
  adopted, or paid for.

Treat a real outside update cycle with a retained decision as product evidence.
A local fixture or generated entry is implementation proof only.

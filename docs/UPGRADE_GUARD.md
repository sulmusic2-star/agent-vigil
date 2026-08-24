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

## Release status

The public v0.16.0 release added signed control proof; it did not include the
automatic APM materialize-check-restore path, the no-checkout upgrade Action,
or the packaged public update-pair corpus. Those surfaces are prepared in the
v0.17.0 release candidate. Its local proof-network and Team implementations
are disabled and undeployed. Verified external adoption, payment, recognized
MRR, and revenue are zero. R0 has not started and requires an independently
reviewed exact release, operational opt-in lifecycle measurement, and a
cleared commercial name gate.

## Current scope

This first version is a local compatibility gate whose behavioral evaluation is
offline. It accepts bounded component directories with JSON manifests. Typical candidates include a packaged plugin,
skill bundle, MCP server, agent extension, or another dependency whose current
and candidate trees can be materialized separately. Updater-native planning can
also normalize exact changes from Microsoft APM lockfiles, Vercel Skills v3
lockfiles, and Agent Plugins 1.0 directories before any behavior check runs.
The plan is private input selection, not a safety verdict.

It does not install the candidate into the user's active agent stack. The old
version remains untouched because both versions are mounted read-only for the
comparison. The automatic APM lane performs an explicit bounded download from
`codeload.github.com`, but it does not upload a receipt or publish an index
entry.

Live model and provider behavior is outside this lane. The runner has no network
access and receives no provider credentials. Mutable model aliases such as
`latest`, authentication behavior, hosted service changes, and production
latency therefore cannot be established by an Upgrade Guard verdict.

## Requirements

- Node.js 20 or newer for Agent Vigil.
- A running Docker-compatible daemon selected through a `unix://` socket or,
  on Windows, an `npipe://` endpoint. Remote SSH, TCP, HTTP, and HTTPS Docker
  endpoints are refused because their bind paths refer to another host. This
  is a transport-shape check, not proof that the daemon is physically local: a
  local socket or named pipe can proxy another daemon.
- For `init` and `doctor`, `--repo` must name the exact root of a Git
  repository, not a parent or nested directory.
- A trusted Linux/amd64 single-platform runner manifest already present
  locally and named by an immutable `@sha256:` digest. Multi-platform index
  digests are rejected because they select different bytes by architecture.
  Upgrade Guard uses `--pull=never`.
- For automatic APM acquisition, a fixed-location `curl` executable or an
  explicit absolute `--fetch-bin` path. Repository-controlled `PATH`, curl
  configuration, proxy variables, redirects, credentials, and non-HTTPS
  protocols are not used.
- The runner image must contain `node`, which the containment preflight uses.
- Pairwise separate, non-overlapping current, candidate, and trusted canary
  directories containing regular files only.

Each artifact directory is limited to 4,096 files, 32 MiB per file, and 256 MiB
in total. Files are hashed in bounded 1 MiB chunks with stable descriptor,
identity, size, and timestamp checks rather than loaded wholly into memory.
The JSON component manifest retains a separate 4 MiB parsing ceiling. Symbolic
links and non-regular filesystem entries are refused. The component manifest
must remain inside its artifact directory and match the configured component
identity.

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

Normalize a manager-native old/new state into exact update pairs. APM and
Skills inputs are lockfiles; Agent Plugins inputs are complete plugin
directories:

```bash
vigil upgrade plan \
  --manager apm \
  --current ./states/current/apm.lock.yaml \
  --candidate ./states/candidate/apm.lock.yaml \
  --repo . \
  --output ./.agent-vigil/upgrade/update-plan.json

vigil upgrade plan \
  --manager skills \
  --current ./states/current/.skill-lock.json \
  --candidate ./states/candidate/.skill-lock.json \
  --repo .

vigil upgrade plan \
  --manager agent-plugin \
  --current ./artifacts/plugin-current \
  --candidate ./artifacts/plugin-candidate \
  --repo .
```

The plan follows the [update-plan schema](update-plan-v1.schema.json). It binds
the two manager states, distinguishes updates from additions and removals, and
marks only old/new endpoints with distinct exact artifact identities as requiring behavioral preflight. It
does not fetch, install, execute, or declare an update safe. APM support reads
lockfile versions 1 and 2. It binds every dependency field and a distinct
`apm-workspace` digest covering every top-level field except `dependencies` and
APM's documented diagnostic-only `generated_at` and `apm_version` fields. This
includes MCP commands and arguments, MCP/LSP ownership and target state, local
deployment state, the canonical deployment ledger, and unknown additive fields;
YAML scalar source and style, including non-finite values and coercion-prone
spellings such as `01` versus `1`, remain distinct. The parser follows
OpenAPM's failsafe scalar contract and rejects custom tags, anchors, and aliases;
changing bound state produces a nonzero plan. Behavioral preflight is required
only when the old and new exact artifact identities differ; same-artifact
metadata drift remains visible as `UNAVAILABLE`. APM repository URLs, names,
hosts, sources, local paths, declared versions, tags, refs, and additive fields
remain private inputs: plans emit only a stable pseudonymous dependency identity,
an integrity-derived endpoint label, exact artifact integrity, and static change
reasons. Parser and duplicate-identity diagnostics do not quote manager input.
The `plan` command itself never fetches or executes anything. The separate
automatic `preflight` command below can materialize one strictly supported APM
row and bind it to the contained check; other manager plans still require the
operator to supply old/new artifact directories.
Skills support reads the current v3 lock shape. Each skill commitment covers
its complete strict-JSON entry except validated installation timestamps,
including `sourceUrl`, `sourceBaseUrl`, `wellKnownDigest`, `pluginName`, and
unknown additive fields. Exact JSON number spellings remain distinct, malformed
UTF-8 is rejected, and required timestamps must be canonical UTC ISO strings.
GitHub entries use an exact 40-character Git tree identity; supported 64-character
content hashes become prefixed SHA-256 identities. Well-known entries require an
empty folder hash, credential-free HTTPS source and base URLs, and an exact
prefixed SHA-256 `wellKnownDigest`. Unsupported source combinations fail closed,
local entries remain unbound, and source/path/owner replacements become separate
removed and added lineages rather than eligible artifact updates. A separate
`skills-workspace` commitment catches unknown top-level manager state as well as
prompt and installation-target preferences. Entry-only metadata drift that does
not change exact artifact integrity remains visible but cannot request a same-artifact
behavioral preflight. Agent Plugins support binds the
complete directory tree plus the declared skill and MCP surface.

Run the complete automatic APM path for one old/new lockfile pair:

```bash
vigil upgrade preflight \
  --repo . \
  --current-lock ./states/current/apm.lock.yaml \
  --candidate-lock ./states/candidate/apm.lock.yaml \
  --config .agent-vigil/upgrade/config.json \
  --output .agent-vigil/upgrade/apm-preflight-receipt.json
```

Automatic preflight requires exactly one total plan change and that change must
be the one exact eligible package pair. Any added, removed, workspace, MCP,
configuration, second update, or otherwise unassessed row returns
`HOLD: UNASSESSED_PLAN_CHANGES`; one favorable pair can never green a broader
lockfile update. `--identity` may bind the expected pseudonymous row but does
not waive this whole-plan rule. Supplying `--plan` requires byte-semantic
equality with a fresh plan over the two supplied lockfiles before acquisition.
A plan is never enough by itself because it
intentionally omits the private source route; both exact lockfiles remain
required.

Re-verify a saved wrapper against those exact lockfile bytes before consuming
its verdict or hash:

```bash
vigil upgrade verify-preflight \
  .agent-vigil/upgrade/apm-preflight-receipt.json \
  --current-lock ./states/current/apm.lock.yaml \
  --candidate-lock ./states/candidate/apm.lock.yaml \
  --repo . \
  --config .agent-vigil/upgrade/config.json
```

This independently recomputes the plan and selected-row bindings, both receipt
hashes, every recorded canary comparison from its aggregate evidence, the
decision, artifact commitments, restoration state, and nested verdict. The
trusted repository and config are required so verification can also rebind the
runner, component, canary IDs and commands, configuration digest, and current
canary-harness inventory. A non-HOLD receipt requires every containment control
to be true. The command exits successfully only for a structurally and
semantically valid wrapper; callers must separately enforce the preflight
exit-to-verdict mapping (`0` to `SAFE`, `1` to `CHANGED`, `2` to `HOLD`).

The selected row must also be a pure artifact version/tree transition. Changes
to deployment selection, skill/target subsets, package type, virtual path,
marketplace ownership, constraints, or deployment ledgers return
`HOLD: UNMATERIALIZED_ROW_STATE_CHANGED` until an exact materialization
transform implements and verifies those semantics.

Automatic materialization is deliberately narrow. Both selected rows must be
credential-free public GitHub git sources, expressed as `repo_url: owner/repo`
with `host: github.com` or as `repo_url: github.com/owner/repo`, with a lowercase
40-character `resolved_commit` and OpenAPM `tree_sha256`. The adapter requests
only `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>`, permits no
redirect, and recomputes the OpenAPM canonical tree SHA-256 before writing the
artifact. Registry sources, local paths, ports, proxies, alternate hosts,
unknown dependency fields, missing tree identities, or unsupported route
shapes return `HOLD` without falling back to the active installer. R0 also
rejects every `virtual_path`: the receipt binds the selected artifact directly
to the full repository `tree_sha256`, and a subdirectory will not be supported
until a verifiable subtree proof is part of the contract.

The compressed response is limited to 64 MiB; expanded files retain the same
4,096-file, 32-MiB-per-file, and 256-MiB-total ceilings used by Upgrade Guard.
The automatic APM lane narrows the configured JSON manifest to 64 KiB. It
stores those exact bytes as canonical base64 in the private wrapper so an
offline verifier can bind them to the selected-tree file commitment and derive
the manifest hash, component identity, version, and configured capability
snapshots itself. The ordinary already-materialized check retains its separate
4 MiB manifest ceiling.
Tar paths must share one root and remain normalized. The exact leading GitHub
codeload global PAX `comment=<commit>` record is validated against the selected
commit; every other extension record, link, device, special entry, traversal,
Unicode/case-folding collision, or unsafe name returns `HOLD`. No `apm install`, package install script,
repository hook, or lifecycle command runs.

The command checkpoints both lockfile digests before acquisition, before the
contained check, and after the check. Its private
[automatic APM receipt](apm-preflight-v1.schema.json) contains the complete
pseudonymized plan, selected-row commitments, route commitment, locked commits,
expected tree hashes, downloaded byte hashes and counts, materialized tree
hashes, a bounded sorted path/mode/size/blob commitment that lets verification
recompute both the OpenAPM tree and selected artifact inventory, the bounded
exact configured-manifest bytes used to recompute every nested target field,
the nested Upgrade Guard receipt, and
the final restoration result. It never copies lockfile acquisition-route fields
into the receipt; the exact public-source manifest may itself contain package
metadata, so this wrapper remains private and public proof export stays
separate. A `SAFE` or `CHANGED` wrapper requires the nested verdict to agree and
the exact temporary session to be removed; cleanup failure becomes `HOLD`.
The pretty-printed private receipt must fit the verifier's 4 MiB input bound;
an over-bound evidence set returns a minimal `HOLD` receipt instead of a
compatibility verdict.

Temporary materialization defaults to the trusted configuration directory so
Docker Desktop and Colima can bind it. CI can select an already-existing shared
directory such as `RUNNER_TEMP` with `--work-directory`. Current/candidate
lockfiles and an explicit `--output` may live outside the checkout; the
configuration and canary harness remain trusted repo-contained inputs. Signal
handlers attempt the same bounded cleanup for `SIGINT` and `SIGTERM`; no program
can promise cleanup after `SIGKILL`, power loss, kernel failure, or a privileged
same-host replacement.

Exit codes retain the normal Upgrade Guard contract: `0` for `SAFE`, `1` for
`CHANGED`, and `2` for `HOLD` or usage failure. The default wrapper output is
`.agent-vigil/upgrade/apm-preflight-receipt.json`. `--public-output` remains
opt-in and is created only after a non-`HOLD` nested receipt and successful
restoration.

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

Create a copyable, privacy-minimized maintainer issue packet from a signed
entry. The pinned publisher key is mandatory:

```bash
vigil upgrade evidence \
  ./compatibility-entry.json \
  --output ./maintainer-evidence.md \
  --public-key ~/.config/agent-vigil/compatibility-public.pem
```

When one baseline-to-candidate entry is `CHANGED` and a later comparison from
the same exact baseline is `SAFE`, link the broken and restored versions with a
separately signed resolution record:

```bash
vigil upgrade resolve \
  --broken ./baseline-to-broken.json \
  --fixed ./baseline-to-fixed.json \
  --output ./compatibility-resolution.json \
  --public-key ~/.config/agent-vigil/compatibility-public.pem \
  --signing-key ~/.config/agent-vigil/compatibility-private.pem
```

Both entries must have the same component, publisher, exact baseline, runner,
configuration, and canary-harness commitments. The broken entry must be
`CHANGED`, the fixed entry must be `SAFE`, their candidate artifacts must
differ, and the fixed entry's signed `generatedAt` must be strictly later than
the broken entry's. The relation means only that the later recorded candidate
restored the baseline observations. Its contract is the
[compatibility-resolution schema](compatibility-resolution-v1.schema.json).

Resolution v1 deliberately has no external URL field. URL user information,
queries, fragments, and opaque path segments can all carry credentials or
private share tokens, so `--evidence-url` is rejected instead of copying an
unverifiable locator into a signed public artifact. Publish a separately
reviewed issue link next to the resolution when one is needed.

An organization can enforce one exact signed entry against an organization-
owned fleet policy:

```bash
vigil upgrade enforce \
  ./compatibility-entry.json \
  --policy ./fleet-policy.json \
  --public-key ~/.config/agent-vigil/compatibility-public.pem \
  --expected-current-version 1.0.0 \
  --expected-candidate-version 1.1.0 \
  --expected-current-artifact-sha256 sha256:<current-tree-digest> \
  --expected-candidate-artifact-sha256 sha256:<candidate-tree-digest> \
  --output ./fleet-decision.json
```

Fleet policy v1 is deliberately fail-closed. It can allow only `SAFE` evidence
and requires exact allowlists for publisher key, component, runner image,
configuration, and canary harness, plus a maximum evidence age and minimum
canary count. It has no switch that permits `CHANGED` or `HOLD` and no inline
exception that a candidate update can redefine. See the
[fleet-policy schema](fleet-policy-v1.schema.json) and
[fleet-decision schema](fleet-decision-v1.schema.json). This local gate is an
enforcement primitive; it is not hosted policy distribution, identity
management, billing, or proof that an organization has deployed the policy.

The four `--expected-*` values are the deployment-intent trust boundary. A
trusted deployment controller must derive them independently from the actual
installed baseline and intended candidate; copying them from the compatibility
entry would recreate the replay flaw this gate prevents. The policy and pinned
public key must likewise come from organization-controlled state outside the
candidate. Agent Vigil compares and receipt-binds those caller assertions, but
cannot prove that the caller sourced them independently.

Build a searchable standalone page, static JSON API, and optional Shields
endpoint files from signed entries and resolution records:

```bash
vigil upgrade index \
  ./compatibility-entry.json \
  ./another-compatibility-entry.json \
  ./compatibility-resolution.json \
  --output ./agent-compatibility-index.html \
  --api-output ./compatibility-registry.json \
  --badge-directory ./badges \
  --public-key ~/.config/agent-vigil/compatibility-public.pem
```

The badge directory must already exist. The index command verifies every entry
and resolution before writing anything, then produces a locally searchable
single-file HTML page. Supplying `--api-output` also writes a deterministic
machine-readable registry, and `--badge-directory` writes one
Shields endpoint JSON document per entry when requested. HTML detail anchors
and resolution links make exact broken and restored version pairs directly
shareable. The static API follows the
[compatibility-registry schema](compatibility-registry-v1.schema.json); each
contained record remains independently signed even though the aggregate
registry hash is not a separate publisher signature.

None of these commands host, upload, contact a maintainer, or publish evidence.
`preflight` makes only the explicitly described exact codeload request needed
to acquire a supported public APM pair; the index, evidence, resolve, enforce,
verify, plan, and already-materialized check lanes make no such request.
`--public-key <path>` is required: every entry and resolution must match that
separately pinned signer key. `doctor` and `check` also accept
`--docker-bin <path>` for a compatible Docker client executable. An explicit
value must be absolute and is canonicalized before execution. Without the
option, Upgrade Guard checks only fixed platform Docker locations; it never
selects a repository-controlled executable through `PATH`. Canonicalization
does not authenticate the executable or prove vendor provenance. An explicitly
selected Docker client remains part of the operator-controlled trusted
computing base. This does not change the required Docker engine or containment
contract.

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
    "image": "node:22.22.3-bookworm-slim@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644",
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

`init` currently pins the Linux/amd64 single-platform child manifest shown
above, rather than the multi-platform tag/index. The local Docker inspection
must resolve that exact manifest as `linux/amd64` before any canary can run. The image must
already be stored locally, and you must independently decide whether to trust
it before using its result. A mutable tag alone is never accepted.

For one CLI operation, Upgrade Guard first validates the configuration used to
derive output exclusions and the canary root. At evaluation entry it re-resolves
and rereads the trusted regular file, requires stable device/inode identity
across that read, and requires canonical equality with the CLI-supplied value.
After all trials it repeats the trusted read and requires the canonical path,
device/inode identity, and canonical validated content to match the entry
checkpoint. Any observed mismatch or failed read returns `HOLD`. The receipt
commits to that validated configuration. These two checkpoints do not prove
continuous immutability: a same-host ABA change restored before the final check,
or a privileged filesystem race, remains outside the boundary. Run checks on a
quiescent trusted host.

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
  a receipt-specific nonce-blinded SHA-256 pseudonym, not the bare digest of the
  private ID.
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
- no current/candidate phase label is exposed to evaluated code;
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
values are bounded strings, exact JSON safe integers from
`-9007199254740991` through `9007199254740991`, booleans, or `null`. Decimal,
exponent, negative-zero, unsafe-integer, duplicate-key, and malformed UTF-8
representations return `HOLD`; larger or fractional values must be emitted as
strings. Arrays and nested objects are intentionally unsupported. This keeps
comparison deterministic and limits accidental disclosure.

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
the validated configuration snapshot, each manifest, and each configured
capability value, including whether that field was absent or explicitly
`null`. It then runs a planted containment preflight and the repeated canaries.
The configuration is re-resolved and reread, and all three artifact/canary
trees are re-inventoried afterward; any observed mismatch or unreadable input
returns `HOLD`. The bounded-checkpoint caveat above remains.

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

- a Docker endpoint whose inspected transport is a Unix socket or Windows
  named pipe, and a canonical Docker client from a fixed platform location or
  explicit absolute path, resolved once for the complete evaluation;
- an explicit `--host` carrying that same endpoint on image, probe, trial,
  cleanup, and absence-check calls, with ambient Docker endpoint/context/TLS
  selectors removed from the child environment;
- `--pull=never` and an exact image digest;
- `--network=none`;
- a read-only container root;
- read-only target and canary bind mounts;
- all Linux capabilities dropped;
- `no-new-privileges`;
- the invoking host's numeric non-root UID/GID when available, with a fixed
  unprivileged fallback;
- PID, memory, CPU, and wall-clock limits;
- an unpredictable container name, a hard client deadline, and force-removal
  plus absence verification for that exact container in every exit path; and
- a bounded `noexec,nosuid,nodev` tmpfs at `/tmp`.

Before canaries run, a planted probe must confirm that the target mount and
container root reject writes, a direct network connection is blocked, a host
probe secret was not inherited, and Docker client proxy variables are empty.
Failure to establish any control is `HOLD`.

This is a containment boundary, not proof of harmless code. The Docker daemon,
client, host kernel or virtualization layer, exact runner image, local
socket/pipe routing, and trusted canary harness remain in the trusted computing
base. A local socket can proxy a remote daemon, and a privileged same-host actor
can replace what a pinned socket path reaches. The explicit binding prevents
ambient Docker context changes from redirecting only part of an evaluation; it
does not authenticate the daemon behind the transport. A container escape or
compromised runner can invalidate the result. Do not mount the Docker socket,
credentials, package-manager configuration, cloud configuration, SSH material,
or writable host directories into the runner.

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
  local-endpoint, network, filesystem, and environment containment booleans;
- `SAFE`, `CHANGED`, or `HOLD`;
- allowlisted changed capability categories;
- optional opted-in canary public IDs, otherwise receipt-specific nonce-bound
  pseudonyms that cannot be recomputed from a guessed private label alone;
- the private receipt commitment and explicit limitations; and
- a canonical entry hash and Ed25519 signature.

The endpoint string is deliberately kept out of receipts. Private containment
and public runner evidence instead carry `localEndpoint`, which is `true` only
after a Unix-socket or Windows named-pipe endpoint has been accepted and bound
for the evaluation. Runtime validation and both v1 schemas require `true` for
`SAFE`. This boolean does not authenticate the Docker client or daemon and does
not prove that the daemon behind a local transport is physically local.

It excludes repository identity, local paths, commands, prompts, transcript
text, raw stdout or stderr, environment variables, file names, credentials, and
raw artifact contents. Privacy minimization does not make publication risk-free:
component names, version pairs, artifact hashes, optional `publicId` values, and
the signer key remain visible. Review every public entry before disclosure.

The public network artifacts deliberately remain static and customer-owned:

- the maintainer packet contains only fields already present in a verified
  public entry;
- the registry contains individually signed entries and resolution records,
  and resolution v1 contains no external URL locator;
- badge files contain only `safe`, `changed`, or `hold`; and
- no command enables telemetry or uploads a private receipt; automatic APM
  preflight performs only its disclosed allowlisted artifact GET.

This makes updater integrations, searchable proof pages, issue links, badges,
and registry queries possible without giving Agent Vigil source code, prompts,
commands, raw outputs, local paths, or credentials.

## What this does not prove

- That the canaries cover every meaningful behavior.
- That a `PASS` observation is a correct product requirement.
- That unchanged observations mean unchanged internal implementation.
- That a candidate is free of malicious behavior outside the exercised path.
- That the runner image, Docker daemon, kernel, or host is uncompromised.
- That a syntactically local Docker endpoint reaches a physically local daemon,
  or that a privileged same-host actor did not replace the endpoint behind the
  pinned socket/pipe path.
- That the configuration file was continuously immutable between its entry and
  final checkpoints; a restored same-host ABA change can be unobserved.
- That live provider, model, identity, payment, deployment, or network behavior
  works.
- That an embedded signing key belongs to a particular person or organization.
- That a locally generated public entry has been submitted, accepted, indexed,
  adopted, or paid for.
- That a local implementation, test, commit, or release candidate has begun an
  external release clock. R0 requires a separately reviewed external release
  of this complete path plus operational measurement and name gates.

Treat a real outside update cycle with a retained decision as product evidence.
A local fixture or generated entry is implementation proof only.

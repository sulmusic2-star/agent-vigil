# Hash-locked regression proofs

This directory adds two read-only, deterministic proofs to the 15-pair corpus.
Both proofs parse exact public npm tarballs as inert gzip/tar bytes. They do not
import or execute package code, run install scripts, start child commands or
servers, open sockets or browsers, contact providers, or use accounts and
credentials.

## Result

| Pair | Exact red | Exact green | Proof level |
|---|---|---|---|
| Claude Code 2.1.94 → 2.1.96 | For both `AWS_BEARER_TOKEN_BEDROCK` and skip-auth with a supplied custom Authorization value, 2.1.94 sets `skipAuth`; its embedded Bedrock pre-dispatch hook then deletes Authorization | 2.1.96 moves the value through `apiKey`, leaves `skipAuth` false when a value exists, and preserves the Bearer request shape | Published-artifact request-shape semantics; the live AWS 403 was not replayed |
| Supergateway 3.3.0 → 3.4.0 | The default capacity is one; acquisition is awaited before SSE transport construction; excess requests queue before transport without timeout; release waits for the holding connection to close | 3.4.0 removes the per-session pool acquisition barrier and both scheduled requests reach its transport path | Published-runtime semantics plus trusted deterministic scheduler; no gateway or MCP process ran, and 3.4 was not proven end to end |

Together with the existing Inspector 2.1.0 missing-file proof, the corpus now
has **three independently reproduced material regressions at explicitly bounded
proof levels**. Codex 0.118.0 remains sourced but unreproduced.

## Locked inputs

| Artifact | npm tarball SHA-256 | Relevant unpacked runtime SHA-256 |
|---|---|---|
| `@anthropic-ai/claude-code@2.1.94` | `14a2aa53b5227d165f629bcad120c13fc09728168445c95e95641d62c4b00382` | `cli.js`: `11fa0f142edee45aa24ad60b071345847da6c8b2372d338037fe8c4fd4469564` |
| `@anthropic-ai/claude-code@2.1.96` | `46d70278ea9ac6a8f9c0b772a562c7b90be00a11caa9ba006bc99fbc3a88de58` | `cli.js`: `62ad81e3eb00df80ac019b607cd4bad36607f665bffc7b4e9e3db7ade492d66e` |
| `supergateway@3.3.0` | `d5f56809d24dd39d4f7e7a60cc057943adfc6e312771576698870b730c684fcf` | `dist/index.js`: `8242023e1a86afbdd1fce55418485d9858029996b99c9fe42c7e112e575f67b4`; gateway: `9715b00c9fe1030a5125c5f3a068b86fd9f175d37836878ac18d9e842bb50e41`; pool: `73b84f7c0de5707aab61e46b2db05990015fa529c60724deb27771842928450a` |
| `supergateway@3.4.0` | `380005d495afba26c2fc68a51fc315503d73cf8c3f5a709b5fd0cddde8fb5d3b` | `dist/index.js`: `cebd02836f72bd5b632ed345ed7ce8a4b39e96d464e69a22aef91688e7a68646`; gateway: `9732171ff2f8e759d5355486c9e6908d57827cfb18dd3e3f58afbf6c3cb81b8c` |

`pairs.json` and `metadata/download-verification.tsv` additionally lock the
npm SHA-512 integrity values and source commits for all four versions.

## Exact rerun command

Place the four tarballs in one local directory with the exact names
`claude-old.tgz`, `claude-new.tgz`, `supergateway-old.tgz`, and
`supergateway-new.tgz`, then run from the corpus root:

```sh
ARTIFACT_DIR=/path/to/hash-locked-tarballs
node regressions/reproduce-static-regressions.mjs \
  --artifact-dir "$ARTIFACT_DIR" \
  --output metadata/regression-proof.json

node regressions/validate-corpus.mjs \
  "$ARTIFACT_DIR" \
  metadata/corpus-validation.json
```

The successful result must contain both:

```text
REPRODUCED_REQUEST_SHAPE_REGRESSION
REPRODUCED_CAUSAL_QUEUE_HANG_STATE
```

The checked results are
[`../metadata/regression-proof.json`](../metadata/regression-proof.json) and
[`../metadata/corpus-validation.json`](../metadata/corpus-validation.json).

## Negative controls

The proof fails closed before semantic analysis if any locked tarball, package
version, relevant runtime byte length, or runtime-file SHA-256 differs. Four
one-byte tarball mutations were explicitly rejected.

Claude controls establish that the result is not a version-label or token-word
detector:

- `AWS_BEARER_TOKEN_BEDROCK` is present in both versions.
- The ordinary 2.1.94 credential-chain case remains on the SigV4 path and is
  not classified as the bearer regression.
- Explicit 2.1.96 no-auth mode without an Authorization value stays no-auth;
  the proof does not turn every new-version request green.
- Both vendor-named affected scenarios must independently move from header
  removal to a preserved Bearer shape.

Supergateway controls establish that the signal is the queue topology, not
generic code churn:

- One connection at capacity one does not queue.
- Closing the first connection before opening the second lets the second
  acquire the lease.
- Raising modeled capacity to two lets both long-lived sessions connect.
- The exact 3.4.0 runtime has no process-pool acquisition barrier to classify.

## Why these are genuine published regressions

Anthropic's [2.1.96 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.96)
explicitly identifies the Bedrock 403 as a regression in 2.1.94 and names both
environment modes modeled here. The exact published old bundle contains the
causal contradiction—setting `skipAuth` while supplying Authorization—and its
embedded SDK deterministically deletes that header. The exact new bundle
contains the corresponding `apiKey` correction.

Supergateway's [3.4.0 release](https://github.com/supercorp-ai/supergateway/releases/tag/v3.4.0)
states that it rolled 3.3.0 back because some servers hung. The project's
[concurrency PR discussion](https://github.com/supercorp-ai/supergateway/pull/52)
records the same causal sequence used by the trusted scheduler: an early idle
Inspector connection holds the default-one lease, a later real connection
queues indefinitely, capacity two removes the block, and queueing is identified
as the root cause. Those facts also appear directly in the locked 3.3.0 runtime.

These proofs therefore reproduce published causal failures rather than inventing
synthetic behavior. Their boundary remains narrower than end-to-end provider or
gateway execution, and the corpus reports that boundary rather than upgrading
either result to a universal `SAFE` claim.

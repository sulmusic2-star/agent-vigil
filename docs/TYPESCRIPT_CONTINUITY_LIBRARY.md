# TypeScript continuity verifier

The package subpath `@sulmusic/agent-vigil/continuity-staple` is a small,
offline Node.js verifier for signed Continuity Staples. It makes no network
calls and does not issue or refresh permission.

```ts
import { readFileSync } from "node:fs";
import {
  parseContinuityStapleJson,
  verifyContinuityStaple,
} from "@sulmusic/agent-vigil/continuity-staple";

const result = verifyContinuityStaple(
  parseContinuityStapleJson(readFileSync("continuity-staple.json", "utf8")),
  {
    publicKeyPem: readFileSync("continuity-authority-public.pem"),
    expectedReceiptHash: process.env.EXPECTED_RECEIPT_HASH!,
    expectedHead: process.env.EXPECTED_HEAD!,
    expectedEnvironment: "production",
    expectedPolicySha256: process.env.EXPECTED_POLICY_SHA256!,
    expectedChainTip: process.env.EXPECTED_CHAIN_TIP!,
    minimumSequence: Number(process.env.MINIMUM_SEQUENCE),
  },
);

if (!result.allowsProtectedAction) process.exit(1);
```

The pinned key can instead be supplied as `publicKeyPath`. Exactly one key
input is required. The verifier rejects malformed or oversized JSON, unknown
fields, invalid hashes or signatures, a wrong signer, a wrong receipt, head,
policy, environment, or chain tip, an older sequence, an implausibly future
issue time, and an expired permission.

The package includes language-neutral signed vectors under
`test-vectors/continuity-staple/v1`. The manifest fixes the expected bindings,
verification times, file hashes, and decisions for:

- fresh `CURRENT`;
- expired `CURRENT` becoming `EXPIRED`;
- sticky `REVOKED`; and
- a tampered staple producing `ERROR`.

The test private key is not included. The public vector key must never be
trusted for a protected action.

This library surface is present only in a release that contains these files.
A local build, tarball rehearsal, branch, or pull request is not an npm
publication.

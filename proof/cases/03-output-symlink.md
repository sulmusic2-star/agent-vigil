# Case 03: receipt output followed a symlink

## What was claimed

v0.7 described receipts as local evidence and accepted caller-selected JSON,
SARIF, and GitHub-summary output paths. The implementation used direct
`writeFileSync` and `appendFileSync` calls.

## What the adversarial review caught

At the v0.7 release tree, a symlink supplied as `--output` was followed and its
target was replaced with the JSON receipt.

- Vulnerable release tree: `df04e2a6d9a45909fbac965f1771b1e0b9450224`
- Corrective commit: `a7c96e36f58dda02e83f71f04abaf10fc8e45d9e`
- Reproduction: create `receipt.json -> private-target.txt`, call
  `writeOutputs(..., { output: "receipt.json" })`, and observe that the target
  begins with the receipt JSON.

## Maintainer disposition

v0.8 publication blocked until the output boundary was replaced. JSON, SARIF,
and GitHub summaries now:

- reject symbolic-link and non-regular destinations;
- reject untrusted symlinked parent components;
- write through an exclusive same-directory temporary file;
- flush and atomically rename the completed file;
- use owner-only POSIX mode `0600` (Windows inherits the parent ACL);
- preserve the previous target if writing fails.

## Corrected result

Five adversarial tests pass: direct symlink, symlinked parent, non-regular
destination, atomic replacement and summary preservation. The vulnerable target
remains byte-for-byte unchanged.

## Limit

The fix prevents this filesystem redirection class. It does not make executing
an untrusted repository test command safe; that remains an explicit threat-model
boundary.

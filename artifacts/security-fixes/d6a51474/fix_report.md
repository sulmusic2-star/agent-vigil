# Security remediation index

This directory records the successor fixes for sealed scan
`d6a51474-3449-46ff-8200-de72118224ec`. The authoritative scan bundle was not
modified; its report SHA-256 remains
`bc8cafd72b0e7d7628479b7db90f9b2220a681629dc88a35f706450566ddf2d0`.

- [Proof-network and first-100 findings](./proof_fix_report.md) were fixed in
  source commits `cb10250c9f3b89ac82131b0312389be601a0d00a` and
  `9b35891c3de71f54f79693b2fd56afa599641981`, then integrated over the frozen
  candidate.
- [Team control-plane findings](./team_fix_report.md) were fixed in source
  commit `32744c40836f5067cad22620f9b890b36b482404`, then integrated over the
  proof-network successor.

These reports document local remediation and validation. They do not establish
release, deployment, R0, adoption, payment, renewal, MRR, or revenue. The
combined successor still requires complete exact-SHA gates and a fresh sealed
security review.

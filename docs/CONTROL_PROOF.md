# Control Proof

`vigil prove` checks that the installed Agent Vigil controls still make the
decisions they are supposed to make before you rely on them in a pull request.

```bash
vigil prove --repo . --base HEAD
```

The command clones the selected commit into a temporary local directory. It
does not alter the working repository, push a branch, or call an agent or model
provider. Installed Git and its configuration remain part of the trusted local
environment. In the temporary clone it checks these cases:

1. an unchanged authority surface passes;
2. a new MCP server is blocked;
3. a candidate's attempt to approve its own new authority stays blocked;
4. an unreadable supported authority file stays on hold;
5. a weaker Codex sandbox is blocked; and
6. a newly skipped test is blocked by the calibrated Test Integrity Guard.

The temporary clone must also be removed successfully. The overall result is
`PASS` only when every expected result is observed and cleanup succeeds. Any
unexpected verdict, setup error, or cleanup error returns `HOLD` with exit code
2.

## Receipt

Use `--output` to retain the machine-readable receipt:

```bash
vigil prove --repo . --base HEAD --output .agent-vigil/control-proof.json
```

The receipt records the exact starting commit, the synthetic challenge commits,
expected and actual results, reproduction command, stated limits, and a
SHA-256 digest over that payload. It does not contain application code or test
output.

## What this proves

The receipt proves that this installed Agent Vigil build handled the listed
synthetic changes as expected in a disposable clone.

It does not prove that GitHub branch protection requires Agent Vigil, that an
administrator cannot change a ruleset, that runtime permissions match files in
the repository, or that every detector works. Those controls need separate
evidence. Run Control Proof on a schedule and after changing Agent Vigil,
workflow policy, or agent configuration.

## GitHub Action

The Action can run the same proof on demand or on a schedule:

```yaml
- id: control-proof
  uses: sulmusic2-star/agent-vigil@v0.15.0
  with:
    mode: prove
    repo: .
    head: ${{ github.sha }}
```

Retain `steps.control-proof.outputs.report` as an artifact. `HOLD` exits 2, so an
unexpected decision or cleanup error fails the job.
The `v0.15.0` tag is the planned release for this feature and does not exist
until that release is published.

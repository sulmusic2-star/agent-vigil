# Guard Compatibility

`vigil guard-compat` checks whether one installed control process still returns
the expected decisions for Claude Code or Codex `PreToolUse` input.

It answers a narrow question: does the selected control process distinguish
one allowed marker from one denied marker? The receipt also commits to the
selected host file, control invocation, policy, configuration, and operating
system so a later run can detect a changed setup.

## The two canaries

Both canaries are harmless shell commands. If they run, they only print a
marker.

```text
printf '%s\n' 'AGENT_VIGIL_PROCESS_CONFORMANCE_ALLOW_V1_<nonce>'
printf '%s\n' 'AGENT_VIGIL_PROCESS_CONFORMANCE_DENY_V1_<nonce>'
```

The supplied policy must allow the first marker and deny the second marker.
The random nonce prevents a captured payload from being reused as the current
run. Agent Vigil sends each command inside the host's documented `PreToolUse`
JSON shape. Agent Vigil does not execute either command.

## Run the check

```bash
cat > control-args.json <<'JSON'
["/opt/company-guard/hook.mjs"]
JSON

vigil guard-compat \
  --host codex \
  --host-version 0.149.1 \
  --host-executable /opt/codex/bin/codex \
  --control-name "Company coding control" \
  --control-version 4.2.0 \
  --control-executable /usr/bin/node \
  --control-artifact /opt/company-guard/hook.mjs \
  --control-args control-args.json \
  --policy /opt/company-guard/policy.json \
  --configuration .codex/hooks.json \
  --output guard-compatibility.json
```

The control command is launched directly with an argument array. Agent Vigil
does not pass it through a shell. The argument file must contain a JSON array
of no more than 32 strings.

The check runs in a fresh temporary directory with a temporary `HOME`. Common
cloud, GitHub, proxy, and model-provider credentials are not inherited. The
control still runs with the current user's operating-system authority, so use
only a control you already trust.

## Decisions

Each challenge records one of five decisions:

- `ALLOW`: the control used the host's supported allow shape.
- `DENY`: the control used the host's supported deny shape or exited with code
  2.
- `DEFER`: the control returned no decision, plain text, or a supported Claude
  `ask` or `defer` result.
- `ERROR`: the process failed, timed out, exceeded the output limit, or returned
  a malformed or unsupported result.
- `UNKNOWN`: the process returned a decision value that this adapter does not
  recognize.

`PASS` requires exactly `ALLOW` for the allow canary and `DENY` for the deny
canary. An allow-all control, a deny-all control, a silent control, and a
crashed control all fail. An unknown decision makes the result inconclusive.

Claude Code and Codex both support structured `PreToolUse` allow and deny
results and exit code 2 denial. Their remaining behavior differs. The adapter
keeps the differences explicit:

- Claude Code supports `ask` and `defer`; this check records both as `DEFER`.
- Claude Code can honor valid structured output on another nonzero exit.
- Codex currently treats `ask`, `continue`, `stopReason`, and `suppressOutput`
  as unsupported for `PreToolUse`; this check records them as `ERROR`.
- Codex accepts the older top-level `{ "decision": "block" }` denial shape.
- Plain text does not make a control decision for either adapter.

Sources checked on August 25, 2026:

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex hooks reference](https://learn.chatgpt.com/docs/hooks)

## Receipt bindings

The receipt contains SHA-256 commitments to:

- the selected Claude Code or Codex executable;
- the control launcher and control artifact;
- the ordered control argument array;
- the policy file and host configuration file;
- the challenge pack;
- the operating-system type, release, architecture, and a privacy-reduced
  machine identity.

The receipt contains version labels supplied by the operator. The executable
hashes bind the selected files, but they do not prove who published them. A
file commitment also does not prove that the control read the named policy or
configuration. When a separate control artifact is named, one control argument
must resolve to that artifact; this prevents a receipt from naming an artifact
that was not part of the invocation. The receipt excludes executable
paths, arguments, canary text, command output, user names, home-directory
paths, and environment values.

## Deployment remains on HOLD

This command exercises the control process directly. It does not launch Claude
Code or Codex. It cannot prove that the installed host configuration matched a
real tool call, that every tool path is covered, or that the host honored the
decision.

Every receipt therefore carries:

```json
{
  "deployment": {
    "state": "HOLD",
    "reasonCodes": ["LIVE_HOST_ROUTE_NOT_PROVEN"]
  }
}
```

A later live-host driver must prove routing with the same harmless markers
before any deployment gate can move beyond `HOLD`. The process check must never
be relabeled as live-host proof.

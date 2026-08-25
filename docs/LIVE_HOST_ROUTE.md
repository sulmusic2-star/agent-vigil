# Live-host routing drill

`vigil guard-route` launches one exact Claude Code or Codex executable in an
empty workspace and checks whether the host actually calls a temporary
`PreToolUse` control.

This is the second guard-assurance check. Run `vigil guard-compat` first when
testing your own production control. A direct process check cannot replace this
host-routing drill.

## What the drill does

1. Refuses the ordinary Claude or Codex profile.
2. Requires a marked disposable profile.
3. Installs a temporary control that denies every tool call except the run's
   exact harmless allow canary.
4. Runs the same control directly to prove process conformance.
5. Asks the selected host to make two separate Bash calls.
6. Requires the allow call to create its one disposable marker file.
7. Requires the deny call to be routed, denied, and leave no marker file.
8. Requires distinct host-owned tool-call identifiers from one host session.
9. Removes the temporary host configuration and checks that ordinary user
   configuration files did not change.

The commands only use `printf` and relative files inside a fresh temporary
workspace. The reduced receipt excludes the prompt, host output, transcript,
commands, marker text, paths, user name, profile contents, and credentials.

## Prepare a disposable profile

Create a new private directory and place this exact marker in it:

```text
agent-vigil disposable host profile v1
```

The filename must be:

```text
.agent-vigil-disposable-profile
```

Authenticate the selected host in that disposable profile using the host's
supported login procedure. Do not reuse the ordinary `~/.codex` or `~/.claude`
directory. The command refuses either ordinary profile and refuses to overwrite
an existing `hooks.json`, `config.toml`, `settings.json`, or
`settings.local.json` in the disposable profile.

## Run one host

```bash
vigil guard-route \
  --host codex \
  --host-version 0.149.1 \
  --host-executable /exact/path/to/codex \
  --profile-home /exact/path/to/disposable-codex-profile \
  --output codex-live-route.json
```

Claude Code uses the same command with `--host claude` and its exact version
and executable.

Exit codes are:

- `0`: the selected host passed;
- `1`: routed evidence contradicted the expected outcome;
- `2`: evidence was inconclusive or the command was used incorrectly.

After retaining the reduced receipt, delete the entire disposable profile and
verify that it no longer exists. The receipt says `OPERATOR_REQUIRED` because
Agent Vigil removes only the temporary configuration it created, not an
operator-provided directory that may contain authentication material.

## Passing rules

A host passes only when all of these are true:

- the exact generated control passes its direct allow and deny challenges;
- the host exits normally;
- exactly two expected live calls reach the control;
- no unexpected tool call reaches the control;
- the allow call executes once with exact marker contents;
- the deny call does not execute;
- both calls have distinct host-owned tool-call identifiers from one session;
- the temporary host configuration is removed; and
- the ordinary user configuration remains unchanged.

A host that fails before any routed call is `INCONCLUSIVE`. A malformed event,
extra tool call, repeated identifier, deny bypass, timeout, or mismatched
evidence cannot pass.

## HOLD and the next gate

Every receipt keeps deployment on `HOLD`. A passing receipt records
`ONE_HOST_PROVEN`; it does not stand in for the other host. The GitHub plus
Terraform ticket remains blocked until the current Claude Code version and the
current Codex version each produce their own passing receipt.

Coverage is limited to the exact tested Bash route. Codex's official hooks
reference says specialized tool paths can bypass the default hook path.

Official behavior checked on August 25, 2026:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code programmatic mode](https://code.claude.com/docs/en/headless)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)

## What a PASS does not establish

A PASS does not prove that the host package is authentic, that a production
control is correct, that every host tool is covered, that deployment is safe,
or that anyone installed or paid for Agent Vigil. It is one bounded technical
proof needed before the next build ticket.

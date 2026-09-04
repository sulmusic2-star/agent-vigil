# Protected local agent runs

`vigil run` places an external wall-clock boundary around one local command and
writes a privacy-preserving run receipt. On macOS and Linux it launches the
command directly in a new POSIX process group, sends `SIGTERM` when a declared
limit is crossed, waits for the configured grace period, and sends `SIGKILL` if
the group retains live members.

This is a circuit breaker for ordinary runaway agent processes. It is not an OS
sandbox, a billing authority, or proof that completed work was correct.

## Minimal boundary

```bash
vigil run \
  --time-limit 45m \
  --output .agent-vigil/protected-run.json \
  -- codex exec -
```

`--time-limit` is mandatory. The `--` delimiter is mandatory. Agent Vigil calls
the executable with the exact argument array and does not invoke a shell.
Interactive stdin/stdout/stderr remain attached unless JSONL capture is used.
The wall clock starts before command launch. Deadline and trajectory enforcement
remain active while Agent Vigil asynchronously verifies the launched executable,
so verification time cannot extend the declared limit.

## Codex JSONL trajectory boundary

Codex can expose non-interactive events on stdout with `codex exec --json`.
Agent Vigil can capture that stream to a new owner-only file while checking
trajectory limits:

```bash
vigil run \
  --time-limit 45m \
  --capture-jsonl .agent-vigil/codex-run.jsonl \
  --no-progress 8m \
  --max-tool-calls 250 \
  --max-failed-tool-calls 20 \
  --max-identical-tool-calls 8 \
  --max-consecutive-failures 5 \
  --max-observed-tokens 500000 \
  --output .agent-vigil/protected-run.json \
  -- codex exec --json -
```

For a successful run, the captured transcript contains the full child output.
It stays local, is created with mode `0600` on POSIX systems, cannot replace an
existing path, and is capped at 50 MiB. A boundary-crossing chunk is refused and
stops the run with `TRANSCRIPT_SIZE`; it is not written past the cap. The
protected-run receipt contains only digests and counts, not transcript content.
Captured child bytes are mirrored to stdout; the final Vigil summary goes to
stderr so the JSONL stream is not polluted. Use
`--output` for the complete machine-readable receipt. Capture persistence and
stdout mirroring use independent asynchronous queues, so a slow output consumer
cannot pause deadline enforcement or prevent the capture from draining. A
capture or mirror that cannot drain within the bounded shutdown window makes the
run `ERROR`; Agent Vigil does not silently certify a partial transcript.

`--transcript <path>` observes an existing append-only JSONL file instead. The
pre-run calls and token count become the baseline. Replacement, deletion,
truncation, or rewriting after launch stops the run with
`TELEMETRY_INTEGRITY`.

## Limit semantics

- A declared maximum permits exactly that value and stops on the next observed
  unit.
- `--no-progress` resets only after a completed, non-failing repository write,
  test, build, or commit action is observed.
- Terminal output, reasoning text, reads, and an incomplete tool call do not
  count as progress.
- A requested token cap stops with `TOKEN_USAGE_UNAVAILABLE` when the selected
  transcript adapter exposes no token accounting within the telemetry grace
  period.
- Malformed, negative, fractional, or unsafe token counters are unreadable
  telemetry; they are never normalized into observed zero usage.
- A requested trajectory limit stops with `TELEMETRY_MISSING` when no readable
  stream appears within the telemetry grace period.
- Persistently malformed JSONL stops with `TELEMETRY_UNREADABLE`.
- `--budget-usd` always refuses before launch. Agent Vigil does not convert
  token observations into estimated dollars or scrape a terminal UI.

The JSONL content is still emitted by the child. These controls can contain
ordinary loops and regressions, but a hostile child can omit or forge events.
Only the mandatory wall-clock boundary is independent of transcript claims.

## Receipts and exit codes

The JSON receipt follows
[`protected-run-v1.schema.json`](protected-run-v1.schema.json) and has one of
three states:

- `EXITED`: the child exited before a limit; its exit code is propagated.
- `STOPPED`: a limit, supervisor signal, or surviving same-group descendant
  invalidated the protected run. The supervisor terminates a live process group;
  on Linux it inspects every task in a matching thread group before treating
  zombie-only process-group entries as non-executable. Missing or inconsistent
  process-state evidence remains a containment failure. A fast process can
  already be gone when its final buffered evidence crosses a
  trajectory limit. Limit stops return `124`.
- `ERROR`: the supervisor could not establish or retain its boundary. It
  returns `125`, including when process-group termination cannot be confirmed
  after the final kill wait.

Usage errors return `2`. The receipt records an `OBSERVED_ONLY` command result
and an economic result of `NOT_CHECKED`. Its `receiptHash` detects accidental
mutation when recomputed, but it is not a third-party signature. If a stop
interrupts post-launch executable verification, `executableIdentityStable` is
`NOT_CHECKED`; it never claims stability without completed evidence. If a
private `--output` write fails after execution, the receipt remains on the
selected terminal and the CLI returns `125`.

## Security and privacy boundary

- The receipt hashes the resolved executable, executable path, working
  directory, and argv. Hashes are commitments, not encryption. Keep secrets out
  of argv and supply sensitive prompts through stdin.
- Loaded scripts, plugins, models, remote services, and code fetched after
  launch are not authenticated by the executable hash.
- POSIX group termination reaches ordinary descendants. A hostile same-user
  process can call `setsid`, escape the group, kill the supervisor, forge its
  own telemetry, or interfere with the host clock. Strong adversarial
  containment requires a separate OS user, container/cgroup, VM, or managed
  supervisor outside the agent's authority.
- On Linux, termination confirmation ignores `/proc/<pid>/stat` entries that
  the kernel marks zombie or dead. A `hidepid`-inaccessible process owned by a
  different user is outside the documented same-user group boundary; the target
  leader, same-user entries, and entries with unknown ownership remain
  fail-closed when their process-state evidence is incomplete.
- Windows is rejected before launch because this release does not claim an
  equivalent tested process-tree boundary there.
- Nothing is uploaded by `vigil run`.

The captured transcript can later be supplied to `vigil autopsy`. The protected
run receipt is supervision evidence, not an Agent Vigil change receipt, so it
does not satisfy autopsy's `--receipt` input. An earned outcome still requires
separately joined verification, exact cost, and acceptance evidence.

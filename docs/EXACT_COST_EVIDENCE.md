# Exact cost evidence

Agent Vigil can bind a Cursor team usage export to the same transcript and exact
commit pair used by an Agent Vigil receipt. This answers a narrow question:

> What did the provider export say this coding session was charged during the
> export's covered time window?

It does not estimate company ROI, rank developers, or treat a daily team total
as the cost of one pull request.

## Import a Cursor usage export

Export the usage-event JSON with Cursor's Admin API, then run:

```bash
vigil cost-evidence cursor \
  --transcript ./cursor-session.jsonl \
  --usage-export ./cursor-usage.json \
  --output ./agent-vigil-cost.json
```

The import succeeds only for a complete, single-session structured Cursor
stream. It must start with a `system` record, end with a terminal `result`, bind
every root record to the same `conversationId` or `session_id`, and provide
ordered root `timestamp_ms` or `timestamp` values. The Admin API export period
must start no later than the first transcript record and end no earlier than the
terminal record. If the transcript cannot establish those bounds, cost remains
unavailable rather than being presented as exact.

The one transcript session ID must match exactly one `conversationId` in the
provider export. IDs inside assistant text, tool arguments, tool results, or
other nested data do not bind cost. The importer rejects missing or ambiguous
session identity, incomplete pagination, duplicate events, malformed
timestamps, implicit billing state, and invalid charge amounts. Events without
a conversation ID are ignored. Non-chargeable events for the matched session
remain in the observed record count but do not increase the amount.

The accepted Admin API shape is field-specific: each usage-event `timestamp`
is a decimal millisecond string, while `period.startDate` and `period.endDate`
are numeric milliseconds. The importer rejects other timestamp encodings and a
matched-session aggregate above $1,000,000 instead of emitting evidence that a
downstream verifier would refuse.

The output keeps hashes rather than the raw conversation ID. It records:

- the transcript hash;
- the source-export hash;
- a hash of the matched conversation ID;
- observed and chargeable record counts;
- the API export period, matched-event time range, and exported charge; and
- a hash over the complete cost-evidence payload.

## Add cost to a Value Card

```bash
vigil value ./agent-vigil-report.json \
  --transcript ./cursor-session.jsonl \
  --cost-evidence ./agent-vigil-cost.json \
  --github-evidence ./github-evidence.json \
  --format json \
  --output ./agent-value-card.json
```

For this format, Agent Vigil reads the amount directly. A conflicting
`--cost-usd` or `--cost-source` is rejected, and `provider-exported` cannot be
selected for an arbitrary hashed file. The source is labeled
`provider-exported`, not `provider-billed`: hashing proves which export was
used, but a downloaded JSON file is not a provider signature or an invoice.

## Current boundary

- Cursor is the first exact-session adapter because its Admin API exposes a
  conversation ID and charged cents per usage event.
- Daily user or organization totals from other vendors are not assigned to a
  pull request. That would manufacture precision.
- Agent Vigil does not call the Cursor API or retain an admin key in this
  release. The import is local and network-inert.
- A future App adapter may fetch and attest provider data directly. Until then,
  the output proves internal consistency and evidence binding, not provider
  authenticity.

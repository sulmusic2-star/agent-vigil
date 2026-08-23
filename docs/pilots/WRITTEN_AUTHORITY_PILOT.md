# Agent authority change-control pilot

## Outcome

Stop unreviewed coding-agent permission changes before they merge.

## Scope

- One GitHub repository for 30 days.
- MCP, Claude Code, and Codex repository configuration.
- A pull-request check bound to the exact base and head commits.
- Written review of every `BLOCK` or `HOLD` result.
- Rule tuning for the repository's approved operating boundary.
- End-of-pilot record of caught changes, overridden findings, unresolved
  formats, and check retention.

The check runs in the customer's GitHub runner. Source configuration and report
details do not need to be sent to a hosted Agent Vigil service.

## Price

$750 fixed for 30 days, paid before installation. No subscription converts
automatically. Continued service is quoted only after the pilot record is
reviewed.

## Working method

The pilot is asynchronous and written-only. Intake, installation instructions,
finding review, and the final record are handled by email or repository issues.
No meeting, call, or screen share is required.

## Customer inputs

- Written confirmation from a repository owner.
- One technical contact who can approve a workflow change.
- The agent configuration files in pilot scope.
- Agreement on which check, if any, becomes required during the pilot.
- Written disposition for each material finding: accepted, expected, rejected,
  or unresolved.

## Evidence standard

A catch counts only when the repository maintainer confirms that the reported
authority change was material and useful before merge. Installation does not
count as retention until the check remains enabled for 30 days. Payment does
not prove product value, and a local or internal finding does not count as an
external catch.

## Current boundary

This offer is prepared but has not been sent. Payment collection is not
configured. There are no paid pilots, external installations, accepted catches,
or retained checks.

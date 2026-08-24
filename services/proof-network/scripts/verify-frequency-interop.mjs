import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argument = process.argv.indexOf("--corpus");
assert.ok(argument >= 0 && process.argv[argument + 1], "usage: npm run test:frequency-interop -- --corpus /absolute/path/to/corpus");
const corpus = resolve(process.argv[argument + 1]);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const registrationBytes = readFileSync(join(corpus, "frequency", "first-100-registration.json"));
const registration = JSON.parse(registrationBytes.toString("utf8"));
const schemaBytes = readFileSync(join(corpus, "frequency", "first-100-entry-v1.schema.json"));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const anchor = JSON.parse(readFileSync(join(corpus, "frequency", "first-100-ledger.jsonl"), "utf8").trim().split("\n")[0]);
const provenance = JSON.parse(readFileSync(join(corpus, "frequency", "first-100-provenance.jsonl"), "utf8").trim().split("\n")[0]);
const implementation = readFileSync(join(root, "src", "frequency.ts"), "utf8");
const migration = readFileSync(join(root, "migrations", "0001_initial.sql"), "utf8");
const validator = readFileSync(join(corpus, "frequency", "validate-first-100.mjs"), "utf8");

const registrationSha256 = createHash("sha256").update(registrationBytes).digest("hex");
const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
assert.equal(registrationSha256, "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da");
assert.equal(schemaSha256, "db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c");
assert.equal(registration.registrationId, "d0a44ad6-acfc-4542-a5fa-84c68ff37067");
assert.deepEqual(schema.properties.channel.enum, registration.permittedChannels);
assert.deepEqual(schema.properties.eligibility.properties.reason.enum, ["ELIGIBLE", ...registration.excludeReasons]);
assert.deepEqual(anchor, {
  schemaVersion: "diffwitness-first-100-ledger/v1",
  kind: "registration-anchor",
  registrationId: registration.registrationId,
  registrationSha256,
  pairEntries: 0,
});
assert.equal(schema.properties.inspectionStarted.const, false);
assert.equal(schema.properties.pair.properties.componentIdentity.pattern, "^[a-z0-9@][a-z0-9@/._-]*$");
assert.equal(provenance.schemaVersion, "agent-vigil-first-100-provenance-ledger/v2");
assert.equal(provenance.registrationId, registration.registrationId);
assert.equal(provenance.registrationSha256, registrationSha256);
assert.equal(provenance.rawLedgerGateEligibleWithoutProvenance, false);
for (const value of [
  "diffwitness-first-100-entry/v1",
  registration.registrationId,
  registrationSha256,
  ...registration.permittedChannels,
  "ELIGIBLE",
  ...registration.excludeReasons,
]) {
  assert.match(implementation, new RegExp(JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `implementation omits ${value}`);
}
assert.match(implementation, /pairEntries:\s*0/);
assert.match(migration, /FIRST_100_SAMPLE_CLOSED/);
assert.match(migration, /FIRST_100_COMPONENT_CAP/);
assert.match(migration, /component_identity = lower\(component_identity\)/);
assert.match(migration, /component_identity NOT GLOB '\*\[\^a-z0-9@\/\._-\]\*'/);
assert.match(migration, /FIRST_100_EVALUATION_CONTRADICTORY/);
assert.match(validator, /includedByComponent\.get\(pair\.componentIdentity\)/);
assert.match(validator, /provenanceRecordsSha256/);
assert.doesNotMatch(implementation, /eligibility_decision = 'INCLUDED' AND ecosystem = \? AND component_identity = \?/);

const offline = JSON.parse(execFileSync(
  process.execPath,
  [join(corpus, "frequency", "validate-first-100.mjs")],
  { cwd: join(corpus, "frequency"), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
));
assert.equal(offline.registrationId, registration.registrationId);
assert.equal(offline.schemaSha256, schemaSha256);
assert.equal(offline.frequencyVerdict, "INSUFFICIENT_DISTRIBUTION_VOLUME");
assert.equal(offline.included, 0);

process.stdout.write(`${JSON.stringify({
  corpus: "frozen-registration-with-bound-provenance-v2",
  registrationId: registration.registrationId,
  registrationSha256,
  schemaSha256,
  rawLedgerSha256: offline.rawLedgerSha256,
  provenanceSha256: offline.provenanceSha256,
  frequencyVerdict: offline.frequencyVerdict,
  compatible: true,
}, null, 2)}\n`);

import assert from "node:assert/strict";
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
const implementation = readFileSync(join(root, "src", "frequency.ts"), "utf8");
const migration = readFileSync(join(root, "migrations", "0001_initial.sql"), "utf8");

const registrationSha256 = createHash("sha256").update(registrationBytes).digest("hex");
const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
assert.equal(registrationSha256, "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da");
assert.equal(schemaSha256, "b6f090f886d09002163be880adc06c726fafedc81bdb45696ed3e1888f1e7757");
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

process.stdout.write(`${JSON.stringify({
  corpus: "b95d27016731d380d3f2705330c6191bcc32f31f",
  registrationId: registration.registrationId,
  registrationSha256,
  schemaSha256,
  compatible: true,
}, null, 2)}\n`);

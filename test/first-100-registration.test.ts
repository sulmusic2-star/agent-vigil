import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repository = process.cwd();

test("the published first-100 frame is signed, frozen before R0, and empty", () => {
  const output = execFileSync(process.execPath, ["proof/first-100/verify.mjs"], {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  const result = JSON.parse(output) as {
    registrationId: string;
    registrationSha256: string;
    pairEntries: number;
    verified: boolean;
  };

  assert.deepEqual(result, {
    registrationId: "d0a44ad6-acfc-4542-a5fa-84c68ff37067",
    registrationSha256: "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da",
    pairEntries: 0,
    verified: true,
  });

  const registration = JSON.parse(readFileSync(
    join(repository, "proof", "first-100", "first-100-registration.json"),
    "utf8",
  )) as { releaseBoundary: { r0Release: unknown }; sample: { targetEligiblePairs: number } };
  assert.equal(registration.releaseBoundary.r0Release, null);
  assert.equal(registration.sample.targetEligiblePairs, 100);
});

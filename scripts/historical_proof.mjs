#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "proof", "results.json");
const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-proof-"));

function blobMatches(path, expected) {
  return execFileSync("git", ["hash-object", path], { cwd: root, encoding: "utf8" }).trim() === expected;
}

function packContainsPyc(fixture) {
  const snapshot = join(temporary, fixture);
  mkdirSync(snapshot, { recursive: true });
  copyFileSync(join(root, "proof", "fixtures", fixture, "package.json"), join(snapshot, "package.json"));
  const poison = join(snapshot, "scripts", "__pycache__", "planted.pyc");
  mkdirSync(dirname(poison), { recursive: true });
  writeFileSync(poison, "planted package contamination fixture\n");
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: snapshot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `npm pack failed for ${fixture}`);
  const manifest = JSON.parse(result.stdout);
  return manifest[0].files.some((entry) => entry.path.endsWith("scripts/__pycache__/planted.pyc"));
}

function actionUsesFreshDirectory(fixture) {
  const action = readFileSync(join(root, "proof", "fixtures", fixture), "utf8");
  return action.includes("mkdtempSync") && action.includes("agent-vigil-");
}

function outputRejectsSymlink() {
  const target = join(temporary, "private-target.txt");
  const link = join(temporary, "receipt.json");
  writeFileSync(target, "PRIVATE-CONTENT\n", { mode: 0o600 });
  symlinkSync(target, link);
  const before = readFileSync(target, "utf8");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `
      import { writePrivateFileAtomic } from ${JSON.stringify(join(root, "src", "safe-output.ts"))};
      writePrivateFileAtomic(${JSON.stringify(link)}, "unsafe overwrite");
    `],
    { cwd: root, encoding: "utf8" },
  );
  return result.status !== 0 && readFileSync(target, "utf8") === before;
}

try {
  const cases = [
    {
      id: "stale-action-artifact",
      vulnerable: "cadf7d4243c8c923858ea19f76bc018d9ed77cd4",
      corrected: "3a581e8a19e113922e82cda93fefdde41c6d1422",
      observed: {
        vulnerableSnapshotMatchesGitBlob: blobMatches("proof/fixtures/action-vulnerable.yml", "9bf1f2c9a090b656536e013d997f3b362802d24a"),
        correctedSnapshotMatchesGitBlob: blobMatches("proof/fixtures/action-corrected.yml", "0c56e97f3bfc2e1ec1f6ba849c3b0f32b053cad9"),
        vulnerableUsesFreshDirectory: actionUsesFreshDirectory("action-vulnerable.yml"),
        correctedUsesFreshDirectory: actionUsesFreshDirectory("action-corrected.yml"),
      },
      primaryEvidence: "https://github.com/sulmusic2-star/agent-vigil/actions/runs/32413169909",
    },
    {
      id: "package-contamination",
      vulnerable: "8307eba6746d332a653adf58edbd9cafad11a932",
      corrected: "4c505311340e7fd2bc63c5dccd39d78739dc0f12",
      observed: {
        vulnerableSnapshotMatchesGitBlob: blobMatches("proof/fixtures/package-vulnerable/package.json", "8ffff4027d5d1f5cbe1d38eebe5baec5048c9775"),
        correctedSnapshotMatchesGitBlob: blobMatches("proof/fixtures/package-corrected/package.json", "c10b15ffe024e02f78913f7850821b3ca1feb893"),
        vulnerablePackContainsPlantedPyc: packContainsPyc("package-vulnerable"),
        correctedPackContainsPlantedPyc: packContainsPyc("package-corrected"),
      },
      primaryEvidence: "https://github.com/sulmusic2-star/agent-vigil/pull/10",
    },
    {
      id: "output-symlink",
      vulnerable: "df04e2a6d9a45909fbac965f1771b1e0b9450224",
      corrected: "a7c96e36f58dda02e83f71f04abaf10fc8e45d9e",
      observed: {
        correctedRejectsDirectSymlinkAndPreservesTarget: outputRejectsSymlink(),
      },
      primaryEvidence: "proof/cases/03-output-symlink.md",
    },
  ];

  const expectations = [
    cases[0].observed.vulnerableSnapshotMatchesGitBlob === true,
    cases[0].observed.correctedSnapshotMatchesGitBlob === true,
    cases[0].observed.vulnerableUsesFreshDirectory === false,
    cases[0].observed.correctedUsesFreshDirectory === true,
    cases[1].observed.vulnerableSnapshotMatchesGitBlob === true,
    cases[1].observed.correctedSnapshotMatchesGitBlob === true,
    cases[1].observed.vulnerablePackContainsPlantedPyc === true,
    cases[1].observed.correctedPackContainsPlantedPyc === false,
    cases[2].observed.correctedRejectsDirectSymlinkAndPreservesTarget === true,
  ];
  if (expectations.some((value) => !value)) {
    throw new Error(`historical proof expectation failed:\n${JSON.stringify(cases, null, 2)}`);
  }

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: "Three first-party Agent Vigil release failures; not external adoption evidence.",
    result: "PASS",
    cases,
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`PASS: replayed ${cases.length} historical failures -> ${outPath}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

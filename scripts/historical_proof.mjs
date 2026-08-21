#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "proof", "results.json");
const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-proof-"));

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function archive(commit, destination) {
  mkdirSync(destination, { recursive: true });
  const command = `git archive ${commit} | tar -x -C ${JSON.stringify(destination)}`;
  const result = spawnSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `archive failed for ${commit}`);
}

function packContainsPyc(commit) {
  const snapshot = join(temporary, commit.slice(0, 12));
  archive(commit, snapshot);
  const poison = join(snapshot, "scripts", "__pycache__", "planted.pyc");
  mkdirSync(dirname(poison), { recursive: true });
  writeFileSync(poison, "planted package contamination fixture\n");
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: snapshot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `npm pack failed for ${commit}`);
  const manifest = JSON.parse(result.stdout);
  return manifest[0].files.some((entry) => entry.path.endsWith("scripts/__pycache__/planted.pyc"));
}

function actionUsesFreshDirectory(commit) {
  const action = git("show", `${commit}:action.yml`);
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
        vulnerableUsesFreshDirectory: actionUsesFreshDirectory("cadf7d4243c8c923858ea19f76bc018d9ed77cd4"),
        correctedUsesFreshDirectory: actionUsesFreshDirectory("3a581e8a19e113922e82cda93fefdde41c6d1422"),
      },
      primaryEvidence: "https://github.com/sulmusic2-star/agent-vigil/actions/runs/32413169909",
    },
    {
      id: "package-contamination",
      vulnerable: "8307eba6746d332a653adf58edbd9cafad11a932",
      corrected: "4c505311340e7fd2bc63c5dccd39d78739dc0f12",
      observed: {
        vulnerablePackContainsPlantedPyc: packContainsPyc("8307eba6746d332a653adf58edbd9cafad11a932"),
        correctedPackContainsPlantedPyc: packContainsPyc("4c505311340e7fd2bc63c5dccd39d78739dc0f12"),
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
    cases[0].observed.vulnerableUsesFreshDirectory === false,
    cases[0].observed.correctedUsesFreshDirectory === true,
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

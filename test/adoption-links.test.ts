import test from "node:test";
import assert from "node:assert/strict";
import { adoptionRegistrationUrl, githubRepositorySlug, releasedDoctorCommand, releasedProtectCommand, workflowBadge } from "../src/adoption.ts";

test("GitHub repository identity accepts common exact remotes", () => {
  for (const remote of [
    "https://github.com/example/project.git",
    "git@github.com:example/project.git",
    "ssh://git@github.com/example/project.git",
    "git://github.com/example/project.git",
  ]) assert.equal(githubRepositorySlug(remote), "example/project");
});

test("GitHub repository identity rejects credentials, extra paths, controls, and other hosts", () => {
  for (const remote of [
    "https://token@github.com/example/project.git",
    "ssh://token@github.com/example/project.git",
    "git://token@github.com/example/project.git",
    "ssh://git@github.com:2222/example/project.git",
    "https://github.com/example/project.git?token=secret",
    "https://github.com/example/project/extra.git",
    "https://evil.example/example/project.git",
    "git@github.com:example/project/extra.git",
    "git@github.com:example/project.git\nmarkdown",
    "git@github.com:../project.git",
  ]) assert.equal(githubRepositorySlug(remote), undefined);
});

test("badge and registration links contain only validated repository identity", () => {
  assert.equal(
    workflowBadge("example/project"),
    "[![Agent Vigil workflow](https://github.com/example/project/actions/workflows/agent-vigil.yml/badge.svg)](https://github.com/example/project/actions/workflows/agent-vigil.yml)",
  );
  assert.match(adoptionRegistrationUrl("example/project"), /title=%5Badoption%5D%20example%2Fproject$/);
  assert.throws(() => workflowBadge("example/project/extra"));
  assert.equal(
    releasedDoctorCommand(),
    "npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.3/sulmusic-agent-vigil-0.24.3.tgz doctor --repo .",
  );
  assert.equal(
    releasedProtectCommand(),
    "npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.3/sulmusic-agent-vigil-0.24.3.tgz protect --repo .",
  );
});

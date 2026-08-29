import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the public entry point leads with a no-account PR check and keeps trial registration optional", () => {
  const readme = read("README.md");
  const form = read(".github/ISSUE_TEMPLATE/adopter-feedback.yml");
  assert.match(readme, /Start here.*public pull-request URL.*No login, token, repository write, or source upload/s);
  assert.match(readme, /optionally.*register a trial/s);
  assert.match(form, /Opening this form does not count as an installation/);
  assert.match(form, /workflow that actually uses Agent Vigil/);
  assert.match(form, /required job name by itself does not count/);
});

test("the dated census runs daily and the experiment keeps traffic separate from adoption", () => {
  const workflow = read(".github/workflows/adoption-census.yml");
  const experiment = read("docs/ADOPTION_EXPERIMENT_2026-08-28.md");
  assert.match(workflow, /cron: "17 13 \* \* \*"/);
  assert.match(workflow, /2026-08-28 through 2026-09-11/);
  assert.match(experiment, /clones may include bots, CI, mirrors, and repeated automation/);
  assert.match(experiment, /required job name by itself does not count/);
  assert.match(experiment, /zero configured external repositories/);
  assert.match(experiment, /Do not describe traffic.*as adoption, payment, revenue, or market validation/s);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("the packed README links to the install guide shipped in the same package", () => {
  const readme = readFileSync("README.md", "utf8");
  const guide = "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md";

  assert.ok(existsSync(guide));
  assert.match(readme, /\(docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md\)/);
  assert.match(readFileSync("package.json", "utf8"), /"docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md"/);
  assert.doesNotMatch(
    readme,
    /github\.com\/sulmusic2-star\/agent-vigil\/blob\/main\/docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md/,
  );
  assert.doesNotMatch(
    readme,
    /github\.com\/sulmusic2-star\/agent-vigil\/blob\/v[0-9.]+\/docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md/,
  );
});

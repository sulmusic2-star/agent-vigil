import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("the packed README uses an immutable public link for the unpacked install guide", () => {
  const readme = readFileSync("README.md", "utf8");
  const guide = "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md";
  const immutableSource = "21be5c21d21f4e1845ccc70c9dd0f66f32c65ef1";
  const immutableUrl = `https://github.com/sulmusic2-star/agent-vigil/blob/${immutableSource}/${guide}`;

  assert.ok(existsSync(guide));
  assert.match(readme, new RegExp(`\\(${immutableUrl.replaceAll(".", "\\.")}\\)`));
  assert.doesNotMatch(readme, /\]\(docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md\)/);
  assert.doesNotMatch(
    readme,
    /github\.com\/sulmusic2-star\/agent-vigil\/blob\/main\/docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md/,
  );
  assert.doesNotMatch(
    readme,
    /github\.com\/sulmusic2-star\/agent-vigil\/blob\/v0\.21\.2\/docs\/INSTALL_WITHOUT_NPM_ACCOUNT\.md/,
  );
});

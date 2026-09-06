import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const read = (path: string) => readFileSync(path, "utf8");
test("regression first use states its scope and keeps commercial planning out of the page", () => {
  const page = read("docs/protected-regressions.html"), guide = read("docs/PROTECTED_REGRESSIONS.md");
  assert.match(page, /Local preview.*not a hosted service/);
  assert.match(page, /does not install a required GitHub check/);
  assert.match(page, /independent CI script/);
  assert.match(page, /No receipts are uploaded/);
  assert.match(page, /font:17px/);
  assert.match(page, /max-width:68ch/);
  assert.doesNotMatch(page, /paid service would|earn its keep|product hypothesis|guaranteed|—/i);
  for (const term of ["NaN", "toJSON", "NOT CHECKED", "does not authenticate", "forge its returned value"]) assert.ok(guide.includes(term));
  assert.match(read("scripts/public_surface_gate.py"), /PUBLIC_HTML = \[\s*ROOT \/ "docs\/protected-regressions.html"/);
  assert.match(read("README.md"), /docs\/PROTECTED_REGRESSIONS.md/);
});
test("CI alternative does not import Vigil or offer changed-expectation approval", () => {
  const source = read("examples/protected-regressions/plain-ci.mjs");
  assert.doesNotMatch(source, /from ['"].*(?:agent-vigil|src\/regression)/);
  assert.match(source, /validate\(value\);/);
  assert.match(source, /Contract update needs separate approval/);
  assert.match(source, /--network=none/);
});

test("independent CI rejects a sparse array whose extra property masks its missing slot", async () => {
  const { runInNewContext } = await import("node:vm");
  const { types } = await import("node:util");
  const source = read("examples/protected-regressions/plain-ci.mjs");
  const encoded = source.match(/    const launcher = (`[\s\S]*?`);\n    const run =/)?.[1];
  assert.ok(encoded);
  const launcher = runInNewContext(encoded);
  let status = 0, output = "";
  await runInNewContext(`
    function require(name) {
      if(name === 'node:fs') return {readFileSync:()=>'{"module":"math.cjs","export":"fn","args":[]}'};
      if(name === 'node:util') return {types:{isProxy:proxyCheck}};
      return {fn:()=>Object.assign([,1],{extra:2})};
    }
    ${launcher}
  `, { proxyCheck: types.isProxy, process: { exit:(code:number)=>{status=code;}, stdout:{write:(s:string)=>{output+=s;}} } }, { timeout:1000 });
  assert.equal(status, 71); assert.equal(output, "");
});

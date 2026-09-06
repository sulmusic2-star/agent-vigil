import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
test('the regression guide and its runnable comparison assets are included in package metadata',()=>{
 const manifest=JSON.parse(readFileSync('package.json','utf8'));
 for(const path of ['docs/PROTECTED_REGRESSIONS.md','examples/protected-regressions/plain-ci.mjs','scripts/regression_lab.py']){
  assert.ok(manifest.files.includes(path),path);assert.ok(existsSync(path),path);
 }
});
test('the guide distinguishes an extracted compiled preview from a source checkout',()=>{
 const guide=readFileSync('docs/PROTECTED_REGRESSIONS.md','utf8');
 assert.match(guide,/extracted preview archive/);assert.match(guide,/Do not run\s+`npm run build` in the archive/);
 assert.match(guide,/node dist\/cli.js regression doctor/);assert.match(guide,/Neither copy installs a required GitHub check/);
 assert.match(guide,/not a published package feature/i);
});

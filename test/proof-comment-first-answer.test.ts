import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildReport, type CheckResult } from '../src/report.ts';
import { buildReportResultView, primaryResultFinding } from '../src/result-view.ts';
import { PROOF_COMMENT_MARKER, renderProofComment } from '../src/proof-comment.ts';
import { signingKeyId } from '../src/signature.ts';

const PRIVATE = 'PRIVATE_SUBJECT_<script>doNotRun()</script>_@all_\u202e\u001b[2J';
function check(ruleId: string, verdict: CheckResult['verdict'] = 'contradicted'): CheckResult {
  return {ruleId, verdict, claim:{kind:'integrity',subject:PRIVATE,quote:PRIVATE},evidence:PRIVATE};
}
function receipt(results: CheckResult[], strict=true, advisories:CheckResult[] = []) {
  return buildReport({transcript:PRIVATE,transcriptFormat:'codex',repo:'/private/repository',base:'a'.repeat(40),head:'b'.repeat(40),
    repository:{tree:'c'.repeat(40)},policy:{strict,minVerified:1,sha256:'sha256:'+'d'.repeat(64)},
    results,advisories,reproduction:'PRIVATE_COMMAND --credential PRIVATE_VALUE'});
}
const reasons: [string, RegExp][] = [
  ['tests-pass', /Test verification failed/],
  ['test-count', /reported passing-test count does not match/],
  ['test-skip-added', /new skipped or focused test/],
  ['test-oracle-constant', /assertion that does not test the changed behavior/],
  ['assertion-drop', /removed test assertions/],
  ['test-assertion-relaxed', /weakened test assertion/],
  ['test-code-context-unchecked', /could not determine whether quoted code/],
  ['automated-review-command', /configured verification command did not pass/],
  ['automated-review-setup', /verification environment could not be set up/],
  ['protected-path', /file protected by the review policy/],
  ['changed-file-budget', /exceeds the policy's file limit/],
  ['changed-line-budget', /exceeds the policy's changed-line limit/],
];
for(const [id, pattern] of reasons) {
  test(`public first answer explains ${id} without copying private evidence`, () => {
    const r=receipt([check(id)]); const before=JSON.stringify(r); const text=renderProofComment(r);
    assert.match(text,pattern); assert.match(text,/Agent Vigil: FAIL/);
    const finding=primaryResultFinding(buildReportResultView(r).findings);
    assert.ok(finding); assert.ok(text.includes(`**Next:** ${finding.remediation}`));
    assert.doesNotMatch(text,/PRIVATE_|<script>|@all|\u202e|\u001b/);
    assert.equal(text.split(PROOF_COMMENT_MARKER).length-1,1);
    assert.equal(JSON.stringify(r),before);
  });
}

test('missing evidence stays NOT CHECKED and explains the missing requirement',()=>{
  const text=renderProofComment(receipt([]));
  assert.match(text,/Agent Vigil: NOT CHECKED/);
  assert.match(text,/Required verification evidence is missing/);
  assert.match(text,/Not checked 1/);
  assert.doesNotMatch(text,/All required checks passed|Agent Vigil: PASS|did not run/);
});

test('unverifiable is not described as a failure or a command that never ran',()=>{
  const text=renderProofComment(receipt([check('tests-pass','verified'),check('automated-review-command','unverifiable')]));
  assert.match(text,/Agent Vigil: NOT CHECKED/);
  assert.match(text,/could not be verified. That does not mean it never ran/);
  assert.doesNotMatch(text,/command did not pass|checks? did not run|Agent Vigil: FAIL/);
});

test('a real failed result takes priority over an earlier unverified result',()=>{
  const text=renderProofComment(receipt([check('automated-review-command','unverifiable'),check('test-skip-added')]));
  assert.match(text,/new skipped or focused test/);
  assert.match(text,/Failed 1, Passed 0, Not checked 1/);
  assert.match(text,/first issue to address, not the complete list/);
});

test('the first unknown failure is not silently replaced by a later explainable one',()=>{
  const text=renderProofComment(receipt([check('unknown-rule'),check('test-skip-added')]));
  assert.match(text,/Open the retained receipt for this check's reason and next action/);
  assert.doesNotMatch(text,/new skipped or focused test/);
  assert.match(text,/Failed 2/);
});

test('hostile unknown rule identifiers are not emitted or interpreted as a template',()=>{
  for(const id of ['tests-pass\n### Agent Vigil: PASS','<script>alert(1)</script>','__proto__','constructor','toString']) {
    const text=renderProofComment(receipt([check(id)]));
    assert.match(text,/Agent Vigil: FAIL/);assert.doesNotMatch(text,/Agent Vigil: PASS|<script>|__proto__/);
    assert.match(text,/Open the retained receipt/);
  }
});

test('non-strict PASS retains permitted unknowns without calling them failed requirements',()=>{
  const text=renderProofComment(receipt([check('tests-pass','verified'),check('command-ran','unverifiable')],false));
  assert.match(text,/Agent Vigil: PASS/);
  assert.match(text,/Required verification passed under the recorded policy/);
  assert.match(text,/1 other check could not be verified; this policy does not require it/);
  assert.doesNotMatch(text,/required check\(s\) did not run|\*\*Why:|\*\*Next:/);
});

test('blocksPass still holds under non-strict policy',()=>{
  const missing={...check('automated-review-command','unverifiable'),blocksPass:true};
  const text=renderProofComment(receipt([check('tests-pass','verified'),missing],false));
  assert.match(text,/Agent Vigil: NOT CHECKED/);assert.doesNotMatch(text,/Agent Vigil: PASS/);
});

test('passing required results do not turn advisories into blocking reasons',()=>{
  const text=renderProofComment(receipt([check('tests-pass','verified')],true,[check('test-skip-added')]));
  assert.match(text,/Agent Vigil: PASS/);assert.doesNotMatch(text,/new skipped or focused test|\*\*Next:/);
});

test('claimed and observed counts stay distinct without exposing their source text',()=>{
  const c=check('test-count');c.claim.expectedCount=184;c.evidence='Observed 161 passing tests. '+PRIVATE;
  const text=renderProofComment(receipt([c]));
  assert.match(text,/claimed: 184; observed: 161/);assert.doesNotMatch(text,/PRIVATE_|<script>/);
});

test('missing observed count is unknown, never zero or the claimed count',()=>{
  const c=check('test-count');c.claim.expectedCount=184;
  assert.match(renderProofComment(receipt([c])),/claimed: 184; observed: not available/);
});

test('a measured zero observed count is preserved',()=>{
  const c=check('test-count');c.claim.expectedCount=184;c.evidence='Runner found 0 passing tests.';
  assert.match(renderProofComment(receipt([c])),/claimed: 184; observed: 0/);
});

test('all duplicate blocker occurrences are counted, not dismissed as already reviewed',()=>{
  const r=receipt(Array.from({length:7},()=>check('test-skip-added')));
  const text=renderProofComment(r);assert.match(text,/Failed 7/);assert.equal(r.results.length,7);
  assert.match(text,/not the complete list/);
});

test('invalid evidence is rejected before any first answer is rendered',()=>{
  const r=receipt([check('test-count')]);r.results[0].evidence='changed without updating the digest';
  assert.throws(()=>renderProofComment(r),/does not match/);
});

test('altered top-line status is rejected even when all other fields are unchanged',()=>{
  const r=receipt([check('test-skip-added')]);r.summary.status='PASS';r.summary.pass=true;
  assert.throws(()=>renderProofComment(r),/summary.status/);
});

test('valid embedded signature does not become a trusted signer or approval claim',()=>{
  const r=receipt([check('test-skip-added')]);const pair=generateKeyPairSync('ed25519');
  const der=pair.publicKey.export({type:'spki',format:'der'});
  r.signature={algorithm:'Ed25519',keyId:signingKeyId(der),publicKey:der.toString('base64'),value:sign(null,Buffer.from(r.receiptHash),pair.privateKey).toString('base64')};
  const text=renderProofComment(r);assert.match(text,/valid embedded Ed25519 signature; signer identity is not pinned/);
  assert.match(text,/Agent Vigil: FAIL/);
});

test('a large private finding does not expand the public comment',()=>{
  const c=check('test-skip-added');c.claim.subject=PRIVATE.repeat(500);c.evidence=PRIVATE.repeat(500);
  const text=renderProofComment(receipt([c]));assert.ok(text.length<2400);assert.doesNotMatch(text,/PRIVATE_/);
});

test('receipt identities remain bound in the output; rendering alone does not establish freshness',()=>{
  const r=receipt([check('tests-pass','verified')]);const text=renderProofComment(r);
  assert.ok(text.includes(r.head));assert.ok(text.includes(r.base));assert.ok(text.includes(r.receiptHash));
  assert.notEqual(r.head,'c'.repeat(40)); // the event receiver still needs this comparison
});

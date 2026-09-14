import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkIntegrity,checkIntegrityDiff} from '../src/detectors/reality.ts';
import {preservesLiteralTestParameterization} from '../src/detectors/literal-test-parameterization.ts';
const header="import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from '../math.mjs';\n";
const calls="test('positive',()=>assert.equal(add(2,3),5));\ntest('negative',()=>assert.equal(add(-2,-3),-5));\ntest('zero',()=>assert.equal(add(0,0),0));\n";
const loop="for (const [a,b,answer] of [[2,3,5],[-2,-3,-5],[0,0,0]]) test(`add ${a} ${b}`,()=>assert.equal(add(a,b),answer));\n";
function git(repo:string,...args:string[]) {return execFileSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:repo,encoding:'utf8'}).trim();}
function write(repo:string,path:string,body:string) {mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),body);}
function fixture(t:any,before:Record<string,string>,after:Record<string,string|null>) {
 const repo=mkdtempSync(join(tmpdir(),'vigil-legitimate-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
 git(repo,'init','-q');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
 write(repo,'math.mjs','export const add=(a,b)=>a+b;\n');for(const[p,b]of Object.entries(before))write(repo,p,b);
 git(repo,'add','-A');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD');
 for(const[p,b]of Object.entries(after)){if(b===null)rmSync(join(repo,p));else write(repo,p,b);}
 git(repo,'add','-A');git(repo,'commit','-qm','candidate');const head=git(repo,'rev-parse','HEAD');
 return {repo,base,head,checks:(testCommand='node --test --test-reporter=tap test/*.test.mjs')=>checkIntegrity(repo,base,head,{testCommand})};
}
for(const name of ['a path with spaces.ts','résumé_測試.ts','two b/segments with spaces.ts'])test(`Git path preserves exact identity: ${name}`,t=>{
 const p='src/'+name;const f=fixture(t,{[p]:'export const value=1;\n'},{[p]:'export const value=2;\n'});
 assert.equal(f.checks().some(c=>c.ruleId==='diff-unparseable'),false);
});
for(const quotePath of ['true','false'])test(`Unicode path works with core.quotePath=${quotePath}`,t=>{
 const f=fixture(t,{'src/é.ts':'const x=1;\n'},{'src/é.ts':'const x=2;\n'});git(f.repo,'config','core.quotePath',quotePath);
 assert.equal(f.checks().some(c=>c.ruleId==='diff-unparseable'),false);
});
test('space and Unicode additions and deletions bind /dev/null correctly',t=>{
 const f=fixture(t,{'src/old é space.ts':'const x=1;\n'},{'src/old é space.ts':null,'src/new é space.ts':'const y=2;\n'});
 assert.equal(f.checks().some(c=>c.ruleId==='diff-unparseable'),false);
});
test('exact quoted rename does not invent a deleted test',t=>{
 const body=header+calls;const f=fixture(t,{'test/old é file.mjs':body},{'test/old é file.mjs':null,'test/new é file.mjs':body});
 assert.equal(f.checks().some(c=>c.ruleId==='diff-unparseable'||c.ruleId==='test-file-deleted'),false);
});
test('text assets remain conservative until their execution role is established',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/example.txt':'return x; test.'+'skip("example"); assert(true) -- fixture text only\n'});
 assert.ok(f.checks().some(c=>c.ruleId==='test-skip-added'));
});
test('deleting a text test asset remains a blocking finding',t=>{
 const f=fixture(t,{'test/answer.txt':'expected answer\n'},{'test/answer.txt':null});
 assert.ok(f.checks().some(c=>c.ruleId==='test-file-deleted'));
});
for(const extension of ['snap','mdx','custom'])test(`test skip checks remain active in ${extension} files`,t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{['test/runner.'+extension]:'test.'+'skip("hidden",()=>assert.equal(1,1));\n'});
 assert.ok(f.checks().some(c=>c.ruleId==='test-skip-added'));
});
test('literal parameterization preserves the same callbacks in order',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+loop});
 const checks=f.checks();assert.equal(checks.some(c=>c.ruleId==='test-count-drop'||c.ruleId==='assertion-drop'),false);
 assert.ok(checks.some(c=>c.ruleId==='test-parameterization-preserved'&&c.contributesToPass===false));
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const output=execFileSync(process.execPath,['--test','--test-reporter=tap','test/math.test.mjs'],{cwd:f.repo,encoding:'utf8',env});assert.match(output,/# pass 3\b/);
});
const wrongLoops={
 'removed row':loop.replace(',[0,0,0]',''),
 'duplicate instead of required row':loop.replace('[-2,-3,-5]','[2,3,5]'),
 'changed expected answer':loop.replace('[-2,-3,-5]','[-2,-3,0]'),
 'empty iterable':loop.replace('[[2,3,5],[-2,-3,-5],[0,0,0]]','[]'),
 'conditional registration':loop.replace('test(`add','if (a>0) test(`add'),
 'early break':loop.replace(' test(`add',' { break; test(`add').trim()+' }\n',
 'weakened callback':loop.replace('assert.equal(add(a,b),answer)','assert.ok(true)'),
 'skipped callback':loop.replace(' test(`add',' test.'+'skip(`add'),
 'external iterable':loop.replace('[[2,3,5],[-2,-3,-5],[0,0,0]]','rows'),
 'spread iterable':loop.replace('[[2,3,5],[-2,-3,-5],[0,0,0]]','[...[ [2,3,5],[-2,-3,-5],[0,0,0] ]]'),
};
for(const [name,changed]of Object.entries(wrongLoops))test(`parameterization cannot hide ${name}`,t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+changed});
 assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop'||c.ruleId==='test-body-unreadable'));
 assert.equal(f.checks().some(c=>c.ruleId==='test-parameterization-preserved'),false);
});
test('another changed implementation prevents parameterization equivalence exemption',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+loop,'math.mjs':'export const add=(a,b)=>a-b;\n'});
 assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop'));
});
test('mutable WORKTREE inspection does not claim immutable helper equivalence',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+loop});
 const checks=checkIntegrity(f.repo,f.base,'WORKTREE',{testCommand:'node --test test/math.test.mjs'});
 assert.ok(checks.some(c=>c.ruleId==='test-count-drop'));
 assert.equal(checks.some(c=>c.ruleId==='test-parameterization-preserved'),false);
});
test('changing registration imports prevents an equivalence exemption',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header.replace('node:test','./fake.mjs')+loop});
 assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop'));
});
for(const specifier of ['../math%20alias.mjs','../math#alias.mjs','../math?alias.mjs'])test(`URL-like import does not claim Git/runtime identity: ${specifier}`,()=>{
 const h=header.replace('../math.mjs',specifier);
 assert.equal(preservesLiteralTestParameterization('test/math.test.mjs',h+calls,h+loop,'node --test test/math.test.mjs',()=> 'export const add=(a,b)=>a+b;\n'),false);
});
for(const [path,command,expected] of [
 ['test/.hidden.test.mjs','node --test test/*.test.mjs',false],
 ['.hidden/math.test.mjs','node --test */math.test.mjs',false],
 ['test/.hidden.test.mjs','node --test test/.hidden.test.mjs',true],
] as const)test(`test selection does not guess about hidden paths: ${command}`,()=>{
 assert.equal(preservesLiteralTestParameterization(path,header+calls,header+loop,command,()=> 'export const add=(a,b)=>a+b;\n'),expected);
});
for(const separator of ['\n','\r\n','\v','\u00a0'])test(`shell command boundaries are not argument spaces: ${JSON.stringify(separator)}`,()=>{
 const command=`node --test test/visible.test.mjs${separator}test/math.test.mjs`;
 assert.equal(preservesLiteralTestParameterization('test/math.test.mjs',header+calls,header+loop,command,()=> 'export const add=(a,b)=>a+b;\n'),false);
});
for(const command of ['', 'node --test --test-name-pattern=positive test/*.test.mjs', 'node --test test/other.test.mjs', 'npm test', 'node --test --import ./setup.mjs test/*.test.mjs']) test(`parameterization is conservative for unverified selection: ${command||'missing'}`,t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+loop});
 assert.ok(f.checks(command).some(c=>c.ruleId==='test-count-drop'));
});
test('unchanged arbitrary setup statements prevent parameterization recognition',t=>{
 const setup='Array.prototype[Symbol.iterator]=function*(){yield this[0];};\n';
 const f=fixture(t,{'test/math.test.mjs':header+setup+calls},{'test/math.test.mjs':header+setup+loop});
 assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop'));
});
for(const helper of [
 'Array.prototype[Symbol.iterator]=function*(){yield this[0];};\nexport const add=(a,b)=>a+b;\n',
 'export function add(a,b){ Array.prototype[Symbol.iterator]=function*(){yield this[0];}; return a+b; }\n',
 'export const add=(a,b)=>globalThis.answer;\n',
 'import "./preload.mjs";\nexport const add=(a,b)=>a+b;\n',
])test(`an unverified imported helper cannot obtain a parameterization exemption: ${helper.slice(0,45)}`,t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls,'math.mjs':helper},{'test/math.test.mjs':header+loop});
 assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop'));
});
test('ambient Node options keep source recognition conservative',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+loop});
 const original=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--test-name-pattern=positive';
 try { assert.ok(f.checks().some(c=>c.ruleId==='test-count-drop')); }
 finally {if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original;}
});
for(const name of ['quoted"name.ts','tab\tname.ts','newline\nname.ts','back\\slash.ts'])test(`quoted control/escape name retains unsafe-content detection: ${JSON.stringify(name)}`,{skip:process.platform==='win32'},t=>{
 const p='src/'+name;const f=fixture(t,{[p]:'return value;\n'},{[p]:'if (false) return fallback;\nreturn value;\n'});
 const checks=f.checks();assert.equal(checks.some(c=>c.ruleId==='diff-unparseable'),false);assert.ok(checks.some(c=>c.ruleId==='dead-branch-added'));
});
test('full-file count, not changed line count, detects a real definition drop once',t=>{
 const f=fixture(t,{'test/math.test.mjs':header+calls},{'test/math.test.mjs':header+calls.split('\n').slice(0,2).join('\n')+'\n'});
 assert.equal(f.checks().filter(c=>c.ruleId==='test-count-drop').length,1);
});
function raw(old:string,head:string,diffOld=old,diffNew=head) {return `diff --git ${diffOld} ${diffNew}\n--- ${old}\n+++ ${head}\n@@ -1 +1 @@\n-return value;\n+if (false) return fallback;\n`;}
for(const [name,patch]of Object.entries({
 'mismatched quoted name':raw('"a/src/ok.ts"','"b/src/ok.ts"','"a/src/vendor.ts"','"b/src/vendor.ts"'),
 'bad escape':raw('"a/src/\\q.ts"','"b/src/\\q.ts"'),
 'invalid UTF-8':raw('"a/src/\\377.ts"','"b/src/\\377.ts"'),
 'NUL':raw('"a/src/\\000.ts"','"b/src/\\000.ts"'),
 'path traversal':raw('a/../test/a.ts','b/../test/a.ts'),
 'trailing timestamp':raw('a/src/a.ts\t2026-01-01','b/src/a.ts\t2026-01-01'),
 'unterminated quote':raw('"a/src/a.ts','"b/src/a.ts'),
}))test(`raw diff rejects ${name}`,()=>assert.ok(checkIntegrityDiff(patch).some(c=>c.ruleId==='diff-unparseable'&&c.blocksPass)));
test('readable quoted path still exposes a real weakening finding',()=>{
 const checks=checkIntegrityDiff(raw('"a/src/quote\\\".ts"','"b/src/quote\\\".ts"'));
 assert.ok(checks.some(c=>c.ruleId==='dead-branch-added'));assert.equal(checks.some(c=>c.ruleId==='diff-unparseable'),false);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { verifyReleaseAssembly } from '../scripts/verify_release_assembly.ts';
const pins = ['.github/workflows/agent-vigil.yml','.github/workflows/agent-vigil-merge-group.yml','.github/workflows/agent-vigil-outcomes.yml','.github/workflows/control-proof-weekly.yml','.github/workflows/public-app-gate.yml','hosted/public-app/control-workflow.yml'];
function fixture(t: any, built = 'expected\n', committed = built) {
  const repo = mkdtempSync(join(tmpdir(), 'vigil-release-exact-')); t.after(()=>rmSync(repo,{recursive:true,force:true}));
  const git = (...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const write = (path:string, text:string)=>{mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),text);};
  const commit = (name:string)=>{git('add','-A');git('commit','--allow-empty','-qm',name);return git('rev-parse','HEAD');};
  git('init','-q','--template=');git('config','user.name','Release fixture');git('config','user.email','fixture@example.invalid');
  write('.gitignore','node_modules/\n'); mkdirSync(join(repo,'node_modules'));
  write('build.cjs',`require('node:fs').writeFileSync('dist/cli.js',${JSON.stringify(built)});`);
  write('package.json',JSON.stringify({name:'local-release-fixture',version:'1.0.0',scripts:{build:'node build.cjs'}}));
  write('package-lock.json',JSON.stringify({version:'1.0.0',packages:{'':{version:'1.0.0'}}}));
  write('src/report.ts','export const VERSION = "1.0.0";');write('dist/cli.js',built);
  for(const path of pins) write(path,'uses: sulmusic2-star/agent-vigil@'+'1'.repeat(40)+'\n');
  const base=commit('base');
  write('package.json',JSON.stringify({name:'local-release-fixture',version:'1.0.1',scripts:{build:'node build.cjs'}}));
  write('package-lock.json',JSON.stringify({version:'1.0.1',packages:{'':{version:'1.0.1'}}}));
  write('src/report.ts','export const VERSION = "1.0.1";');write('dist/cli.js',committed);
  const runtime=commit('runtime');for(const path of pins) write(path,`uses: sulmusic2-star/agent-vigil@${runtime}\n`);
  const head=commit('pin');
  return {repo,base,runtime,head,version:'1.0.1',git,write,commit};
}
test('release identity accepts a clean exact-commit deterministic fixture',t=>verifyReleaseAssembly(fixture(t)));
function withNpmCli(value: string | undefined, check: () => void): void {
 const original=process.env.npm_execpath;
 try {
  if(value===undefined) delete process.env.npm_execpath; else process.env.npm_execpath=value;
  check();
 } finally {
  if(original===undefined) delete process.env.npm_execpath; else process.env.npm_execpath=original;
 }
}
test('direct verifier calls build without an npm script environment',t=>{
 const f=fixture(t);withNpmCli(undefined,()=>verifyReleaseAssembly(f));
});
test('npm CLI paths with spaces and shell metacharacters are passed as one Node argument',t=>{
 const f=fixture(t);const tools=mkdtempSync(join(tmpdir(),'vigil npm & tools-'));
 t.after(()=>rmSync(tools,{recursive:true,force:true}));const cli=join(tools,'npm-cli.js');const marker=join(tools,'invocation.json');
 writeFileSync(cli,`const assert=require('node:assert/strict');
assert.deepEqual(process.argv.slice(2),['run','build']);
require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));
const child=require('node:child_process').spawnSync(process.execPath,['build.cjs'],{stdio:'inherit'});
process.exit(child.error||child.signal?1:child.status??1);`);
 withNpmCli(cli,()=>verifyReleaseAssembly(f));
 assert.equal(readFileSync(marker,'utf8'),'["run","build"]');
});
test('a failing selected npm CLI preserves its nonzero exit instead of passing the release',t=>{
 const f=fixture(t);const tools=mkdtempSync(join(tmpdir(),'vigil-npm-failure-'));
 t.after(()=>rmSync(tools,{recursive:true,force:true}));const cli=join(tools,'npm-cli.js');
 writeFileSync(cli,'process.exit(7);');
 withNpmCli(cli,()=>assert.throws(()=>verifyReleaseAssembly(f),(error:any)=>error.status===7));
});
for(const invalid of ['relative','missing']) {
 test(`an invalid ${invalid} npm CLI is rejected without falling back`,t=>{
  const f=fixture(t);const cli=invalid==='relative'?'npm-cli.js':join(f.repo,'missing-npm-cli.js');
  withNpmCli(cli,()=>assert.throws(()=>verifyReleaseAssembly(f),/existing absolute npm CLI file/));
 });
}
test('a repaired working copy cannot hide wrong bytes in the release commit',t=>{
 const f=fixture(t,'expected\n','unreviewed release bytes\n'); f.write('dist/cli.js','expected\n');
 assert.throws(()=>verifyReleaseAssembly(f),/working|committed|deterministic/);
});
test('the requested release must be the checkout being validated',t=>{
 const f=fixture(t);f.commit('unrelated later commit');assert.throws(()=>verifyReleaseAssembly(f),/HEAD|checkout/);
});
test('uncommitted package instructions cannot pass an exact-release check',t=>{
 const f=fixture(t);f.write('README.md','unreviewed instructions\n');assert.throws(()=>verifyReleaseAssembly(f),/working|untracked/);
});
test('untracked dist additions are not covered by the reviewed release',t=>{
 const f=fixture(t);f.write('dist/extra.js','extra\n');assert.throws(()=>verifyReleaseAssembly(f),/working|untracked|dist/);
});
test('wrong committed output fails even when the worktree is clean',t=>{
 const f=fixture(t,'expected\n','wrong\n');assert.throws(()=>verifyReleaseAssembly(f),/deterministic|committed/);
});
for (const matches of [true,false]) {
 test(`replay metadata ${matches?'matches':'cannot drift from'} the single Action pin`,t=>{
  const f=fixture(t);
  f.write(pins[4],`uses: sulmusic2-star/agent-vigil@${f.runtime}\nenv:\n  REVIEWED_RUNTIME_SHA: ${matches?f.runtime:'1'.repeat(40)}\n`);
  f.git('add','-A');f.git('commit','--amend','--no-edit');f.head=f.git('rev-parse','HEAD');
  if(matches) verifyReleaseAssembly(f); else assert.throws(()=>verifyReleaseAssembly(f),/replay runtime/);
 });
}
test('ignored dist additions cannot ride into an otherwise clean release',t=>{
 const f=fixture(t);f.git('config','status.showUntrackedFiles','no');
 f.write('.git/info/exclude','dist/hidden.js\n');f.write('dist/hidden.js','unexpected\n');
 assert.throws(()=>verifyReleaseAssembly(f),/working dist file list/);
});
test('committed dist symlinks are refused before the build executes',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);f.git('reset','--soft',f.base);rmSync(join(f.repo,'dist/cli.js'));symlinkSync('../build.cjs',join(f.repo,'dist/cli.js'));
 for(const path of pins) f.write(path,'uses: sulmusic2-star/agent-vigil@'+'1'.repeat(40)+'\n');
 f.runtime=f.commit('symlink runtime');for(const path of pins) f.write(path,`uses: sulmusic2-star/agent-vigil@${f.runtime}\n`);f.head=f.commit('pin');
 assert.throws(()=>verifyReleaseAssembly(f),/regular Git blobs/);
});

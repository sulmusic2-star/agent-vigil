// Independent CI alternative: no Agent Vigil imports or package needed.
// Requires a trusted host, Git, Docker and the pinned Node image locally.
// Keep THIS script outside the proposed change's authority in a real gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const [repo, base, head] = process.argv.slice(2);
const image = 'node@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3';
const started = performance.now();
let root;
const result = { tool: 'independent-ci', verdict: 'NOT CHECKED', rows: [], reason: '', machineMs: 0 };
try {
  if (![base, head].every(s => /^[a-f0-9]{40}$/.test(s))) throw Error('Exact base/head SHAs required');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
  });
  const read = (sha, path) => {
    const entry = git('ls-tree', '-z', sha, '--', path);
    if (!/^100(?:644|755) blob [0-9a-f]{40}\t[^\0]+\0$/.test(entry)) throw Error('Regular tracked file required');
    return git('show', `${sha}:${path}`);
  };
  for (const sha of [base, head]) if (git('rev-parse', `${sha}^{commit}`).trim() !== sha) throw Error('Commit mismatch');
  const text = read(base, '.vigil-regressions.json');
  if (read(head, '.vigil-regressions.json') !== text) throw Error('Contract update needs separate approval');
  const contract = JSON.parse(text);
  if (contract.version !== 1 || !contract.cases?.length || contract.cases.length > 32 || !contract.files?.length || contract.files.length > 20) throw Error('Invalid contract');
  for (const file of contract.files) if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.cjs$/.test(file) || /(?:^|\/)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(file)) throw Error('Invalid path');
  root = mkdtempSync(join(homedir(), '.vigil-plain-ci-'));
  if (root.includes(',')) throw Error('Unsupported mount path');
  for (const sha of [base, head]) {
    for (const path of contract.files) {
      const target = join(root, sha, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, read(sha, path), { mode: 0o444 });
    }
  }
  const invoke = (sha, item) => {
    const name = 'vigil-plain-' + randomUUID();
    const launcher = `
const fs = require('node:fs'), isProxy = require('node:util').types.isProxy;
const r = JSON.parse(fs.readFileSync(0, 'utf8'));
const emit = process.stdout.write.bind(process.stdout), exit = process.exit.bind(process);
const stringify = JSON.stringify, props = Object.getOwnPropertyDescriptors;
const ownKeys = Reflect.ownKeys, proto = Object.getPrototypeOf, array = Array.isArray;
const plain = Object.prototype, arrayProto = Array.prototype, finite = Number.isFinite, same = Object.is;
let nodes = 0;
function validate(value, depth = 0) {
  if (++nodes > 16384 || depth > 20) throw Error('Unbounded result');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!finite(value) || same(value, -0)) throw Error('Non-JSON number'); return; }
  if (typeof value !== 'object' || isProxy(value)) throw Error('Non-JSON value');
  const a = array(value), p = proto(value);
  if (a ? p !== arrayProto : p !== plain && p !== null) throw Error('Non-plain object');
  const fields = props(value), keys = ownKeys(fields);
  if (a && keys.length !== fields.length.value + 1) throw Error('Sparse or extended array');
  for (const key of keys) {
    if (a && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Non-JSON key');
    if (a && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= fields.length.value)) throw Error('Extended array');
    const field = fields[key];
    if (!field.enumerable || !Object.hasOwn(field, 'value')) throw Error('Accessor or hidden field');
    validate(field.value, depth + 1);
  }
}
Promise.resolve().then(() => {
  const m = require('/work/' + r.module);
  if (!Object.hasOwn(m, r.export) || typeof m[r.export] !== 'function') throw Error();
  return m[r.export](...r.args);
}).then(value => {
  try { validate(value); } catch { exit(71); return; }
  emit(stringify({value}) + '\\n');
}).catch(() => exit(70));`;
    const run = spawnSync('docker', ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--memory-swap=128m', '--cpus=1', '--no-healthcheck', '--ulimit', 'nofile=128:128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777', '--workdir=/work', '--mount', `type=bind,source=${join(root, sha)},target=/work,readonly`, '--env', 'HOME=/tmp', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=', '--entrypoint=node', '-i', image, '--input-type=commonjs', '-e', launcher], {
      input: JSON.stringify({ module: item.module, export: item.export, args: item.args }), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536,
    });
    if (run.error || run.signal) spawnSync('docker', ['rm', '--force', name], { timeout: 5000, stdio: 'ignore' });
    if (run.error || run.status !== 0) return { missing: true };
    try {
      const parsed = JSON.parse(run.stdout);
      if (!parsed || Object.keys(parsed).join() !== 'value' || !Number.isFinite(JSON.stringify(parsed).length)) throw Error();
      return parsed;
    } catch { return { missing: true }; }
  };
  for (const item of contract.cases) {
    if (!contract.files.includes(item.module) || !/^[A-Za-z_$][\w$]*$/.test(item.export) || !Array.isArray(item.args) || !Object.hasOwn(item, 'expect')) throw Error('Invalid case');
    const b = [invoke(base, item), invoke(base, item)];
    const h = b.every(o => !o.missing && isDeepStrictEqual(o.value, item.expect)) ? [invoke(head, item), invoke(head, item)] : [];
    const valid = b.every(o => !o.missing && isDeepStrictEqual(o.value, item.expect)) && h.length === 2 && h.every(o => !o.missing) && isDeepStrictEqual(h[0].value, h[1].value);
    result.rows.push({ id: item.id, verdict: !valid ? 'NOT CHECKED' : isDeepStrictEqual(h[0].value, item.expect) ? 'PASS' : 'FAIL', baseline: b, candidate: h });
  }
  result.verdict = result.rows.some(r => r.verdict === 'FAIL') ? 'FAIL' : result.rows.some(r => r.verdict === 'NOT CHECKED') ? 'NOT CHECKED' : 'PASS';
} catch {
  result.reason = 'Inputs or execution were unavailable; do not approve merging.';
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
  result.machineMs = performance.now() - started;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2;
}

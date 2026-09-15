// Test-only harness. Prepared modes deliberately replace production spawn with
// an already-running REAL child and replay spawn, never exit or process.kill.
// Native modes preserve the production launch path. See tests for the split.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(['cold', 'prepared-capture', 'prepared-relay', 'native-capture', 'native-relay'].includes(mode));
  const prepared = mode.startsWith('prepared-');
  const cold = mode === 'cold';
  const row = JSON.stringify({ type: 'session_meta', payload: { id: 'run' } }) + '\n';
  const transcript = join(directory, 'transcript.jsonl');
  const events = [];
  const mark = (name, detail = {}) => events.push({ name, ms: performance.now(), ...detail });
  const nativeSpawn = childProcess.spawn;
  const nativeWrite = fs.write;
  const nativeKill = process.kill;
  const environment = { ...process.env };
  delete environment.NODE_V8_COVERAGE;
  let child, result, failure, watchdogFired = false;
  let rejectFailure, observeReady, observeExit;
  const fixtureFailure = new Promise((_, reject) => { rejectFailure = reject; });
  fixtureFailure.catch(() => {});
  const ready = new Promise(resolve => { observeReady = resolve; });
  const exited = new Promise(resolve => { observeExit = resolve; });
  const wait = promise => Promise.race([promise, fixtureFailure]);
  const timers = new Set();
  const writes = [];
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    mark('fixture-watchdog');
    rejectFailure(new Error('output fixture did not establish its required events'));
  }, 3_000);
  const delay = ms => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.add(timer);
  });
  const attach = owned => {
    child = owned;
    mark('native-created', { pid: child.pid });
    child.once('spawn', () => mark('native-spawn'));
    child.once('exit', (code, signal) => {
      mark('native-exit', { code, signal });
      observeExit({ code, signal });
    });
    child.once('error', rejectFailure);
  };
  // Fixed fixtures have no descendants. This child-side emergency timer also
  // bounds its lifetime if an outer harness timeout prevents finally running.
  // A native exit with code 91 can never satisfy the successful receipt checks.
  const guard = "setTimeout(()=>process.exit(91),4000).unref();";
  const childScript = cold
    ? guard + "process.on('SIGTERM',()=>{});setTimeout(()=>process.stdout.write(" + JSON.stringify(row) + "),400);setInterval(()=>{},1000)"
    : prepared
      ? guard + "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write(" + JSON.stringify(row) + ",()=>process.send('row-written',()=>process.disconnect()))"
      : guard + 'process.stdout.write(' + JSON.stringify(row) + ')';
  try {
    if (prepared) {
      attach(nativeSpawn(process.execPath, ['-e', childScript], {
        cwd: process.cwd(), env: environment, detached: true, shell: false,
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      }));
      child.once('message', message => {
        if (message !== 'row-written') return rejectFailure(new Error('unexpected readiness message'));
        mark('row-ready');
        observeReady();
      });
      await wait(ready);
      assert.equal(child.stdout.readableFlowing, null, 'preparation must not consume the real stdout pipe');
    }
    childProcess.spawn = (...args) => {
      assert.equal(args[2]?.detached, true);
      assert.equal(args[2]?.shell, false);
      assert.deepEqual(args[2]?.stdio, ['inherit', 'pipe', 'inherit']);
      if (!prepared) attach(nativeSpawn(...args));
      mark('supervisor-spawn', { pid: child.pid, prepared });
      if (prepared) {
        // The real spawn already happened. Only this lifecycle seam is replayed.
        process.nextTick(() => { mark('replayed-spawn'); child.emit('spawn'); });
      }
      return child;
    };
    process.kill = function (pid, signal) {
      if (pid === -child?.pid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        mark('supervisor-' + signal);
      }
      return nativeKill.call(process, pid, signal);
    };
    fs.write = (descriptor, ...args) => {
      // Identify the capture by its actual inode, not by delaying every fs write.
      const capture = descriptor !== 1 && (() => {
        const file = fs.statSync(transcript);
        const target = fs.fstatSync(descriptor);
        return file.dev === target.dev && file.ino === target.ino;
      })();
      const targeted = !cold && (mode.endsWith('-relay') ? descriptor === 1 : capture);
      if (!targeted) return nativeWrite(descriptor, ...args);
      const requestAt = performance.now();
      const callback = args.at(-1);
      mark('write-pending', { descriptor, capture });
      const pending = (async () => {
        try {
          await wait(exited);
          // Enforce a minimum pending interval, not a success-producing timer.
          while (performance.now() - requestAt < 400) {
            await wait(delay(Math.ceil(400 - (performance.now() - requestAt))));
          }
          mark('write-released', { descriptor, pendingMs: performance.now() - requestAt });
        } catch (error) {
          // A watchdog/cancelled prerequisite must unblock cleanup, never pass.
          mark('write-failed', { message: error.message });
          callback(error, 0, args[0]);
          return;
        }
        await new Promise(resolve => nativeWrite(descriptor, ...args.slice(0, -1), (...values) => {
          mark('write-completed', { descriptor, error: values[0]?.message ?? null });
          callback(...values);
          resolve();
        }));
      })();
      writes.push(pending);
    };
    syncBuiltinESMExports();
    const { executeProtectedRun } = await import(pathToFileURL(join(__dirname, '../../src/run-supervisor.ts')).href);
    result = await wait(executeProtectedRun({
      executable: process.execPath, args: ['-e', childScript], cwd: process.cwd(),
      environment, timeLimitMs: prepared || cold ? 100 : 2_000,
      terminationGraceMs: 50, trajectoryLimits: {}, telemetryGraceMs: 200,
      transcript: { path: transcript, transport: 'supervisor-captured-stdout' },
    }));
    mark('supervisor-returned');
  } catch (error) {
    failure = error.stack ?? String(error);
  } finally {
    clearTimeout(watchdog);
    rejectFailure(new Error('fixture finished'));
    for (const timer of timers) clearTimeout(timer);
    fs.write = nativeWrite;
    childProcess.spawn = nativeSpawn;
    process.kill = nativeKill;
    syncBuiltinESMExports();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      mark('fixture-cleanup');
      try { nativeKill.call(process, -child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error.stack; }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 500))]);
    }
    child?.stdout?.destroy();
    if (child?.connected) child.disconnect();
    await Promise.all(writes);
    fs.writeFileSync(join(directory, 'result.json'), JSON.stringify({ mode, events, watchdogFired, result, failure }, null, 2));
  }
  if (failure) throw new Error(failure);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

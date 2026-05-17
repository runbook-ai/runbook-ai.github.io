/**
 * Tests for planner.act() — verifies the browseIndex arg is threaded
 * through to runHeadlessTaskWithConfig as part of initialTaskState, so
 * the worker can name result files as result-${browseIndex}.${ext}.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal globals planner.js may reference (it pulls in task-manager which
// imports task-store which references indexedDB inside function bodies only —
// module load is safe).
globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};

const { act, setActionRunner } = await import('../js/planner.js');

function makeMockRunner() {
  const calls = [];
  const fn = async (action, args) => {
    calls.push({ action, args });
    // Mimic the response shape act() unpacks.
    return {
      taskResult: { result: 'done' },
      taskState: { savedFiles: {}, messages: [], findings: [] },
    };
  };
  fn.calls = calls;
  return fn;
}

test('act: default browseIndex=1 is sent in initialTaskState', async () => {
  const runner = makeMockRunner();
  setActionRunner(runner);
  await act('do something');
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.action, 'runHeadlessTaskWithConfig');
  assert.equal(call.args.initialTaskState.browseIndex, 1);
  setActionRunner(null);
});

test('act: explicit browseIndex is forwarded', async () => {
  const runner = makeMockRunner();
  setActionRunner(runner);
  await act('do something', {}, 4);
  assert.equal(runner.calls[0].args.initialTaskState.browseIndex, 4);
  setActionRunner(null);
});

test('act: savedFiles are merged alongside browseIndex', async () => {
  const runner = makeMockRunner();
  setActionRunner(runner);
  const files = { 'a.png': { name: 'a.png', mimeType: 'image/png', base64: 'AAA', size: 3 } };
  await act('do something', files, 2);
  const its = runner.calls[0].args.initialTaskState;
  assert.equal(its.browseIndex, 2);
  assert.deepEqual(its.savedFiles, files);
  setActionRunner(null);
});

test('act: empty savedFiles still produces browseIndex-only initialTaskState', async () => {
  const runner = makeMockRunner();
  setActionRunner(runner);
  await act('do something', {}, 1);
  const its = runner.calls[0].args.initialTaskState;
  assert.equal(its.browseIndex, 1);
  // No `savedFiles` field when empty (act spreads `{}` only when non-empty).
  assert.equal('savedFiles' in its, false);
  setActionRunner(null);
});

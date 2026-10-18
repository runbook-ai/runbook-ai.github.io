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

// Minimal indexedDB stub so buildWorkspaceContext()/getDailyMemories() resolve
// to an empty store under node (runPlan reaches them on every run).
const emptyStore = {
  getAll() {
    const req = { onsuccess: null, onerror: null, result: [] };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  },
};
globalThis.indexedDB = {
  open() {
    const req = { onsuccess: null, onerror: null, onupgradeneeded: null,
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => emptyStore,
        transaction: () => ({ objectStore: () => emptyStore }),
      } };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  },
};

const { act, runPlan, setActionRunner, PLANNER_TOOLS, PLANNER_ENVELOPE } = await import('../js/planner.js');

// Runner that captures the system prompt sent to the LLM and short-circuits
// the planner loop by returning a single `done` tool call.
function makePlannerRunner() {
  const seen = {};
  const fn = async (action, args) => {
    if (action === 'callLLMWithTools') {
      seen.systemPrompt = args.messages.find(m => m.role === 'system')?.content;
      seen.opts = args.opts;
      seen.tools = args.tools;
      return { toolCalls: [{ id: '1', function: { name: 'done', arguments: JSON.stringify({ summary: 'ok' }) } }] };
    }
    return {};
  };
  fn.seen = seen;
  return fn;
}

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

test('runPlan: personal notes from config are injected into the system prompt', async () => {
  const runner = makePlannerRunner();
  setActionRunner(runner);
  await runPlan({
    prompt: 'do something',
    runCount: 1,
    config: { personalNotes: 'My name is Jun. Prefer concise answers.' },
  });
  assert.match(runner.seen.systemPrompt, /## Personal notes from user/);
  assert.match(runner.seen.systemPrompt, /My name is Jun\. Prefer concise answers\./);
  setActionRunner(null);
});

test('runPlan: no personal notes section when config.personalNotes is unset', async () => {
  const runner = makePlannerRunner();
  setActionRunner(runner);
  await runPlan({ prompt: 'do something', runCount: 1, config: {} });
  assert.doesNotMatch(runner.seen.systemPrompt, /## Personal notes from user/);
  setActionRunner(null);
});

// Progress fields (docs/interactive-agent-design.md in auto-chrome): the
// planner sends its envelope on every think() call, every tool carries the
// native-mode `reasoning` param, and the prompt section is appended outside
// DEFAULT_AGENTS (a custom AGENTS text replaces that).
test('runPlan: think() passes PLANNER_ENVELOPE to callLLMWithTools', async () => {
  const runner = makePlannerRunner();
  setActionRunner(runner);
  await runPlan({ prompt: 'do something', runCount: 1, config: {} });
  assert.deepEqual(Object.keys(runner.seen.opts.envelope.fields), ['taskObservation', 'taskPlan']);
  assert.equal(runner.seen.opts.envelope.param, 'reasoning');
  setActionRunner(null);
});

test('PLANNER_TOOLS: every tool requires the reasoning carrier with the envelope fields', () => {
  for (const t of PLANNER_TOOLS) {
    const p = t.function.parameters;
    assert.equal(Object.keys(p.properties)[0], 'reasoning', t.function.name);
    assert.equal(p.required[0], 'reasoning', t.function.name);
    assert.deepEqual(p.properties.reasoning.required, Object.keys(PLANNER_ENVELOPE.fields), t.function.name);
  }
});

test('runPlan: progress-field section is in the system prompt', async () => {
  const runner = makePlannerRunner();
  setActionRunner(runner);
  await runPlan({ prompt: 'do something', runCount: 1, config: {} });
  assert.match(runner.seen.systemPrompt, /## Progress fields: taskObservation and taskPlan/);
  assert.match(runner.seen.systemPrompt, /never describe page fields, buttons, element ids/);
  setActionRunner(null);
});

/**
 * Tests for monitor.js — runMonitorPoll behavior.
 *
 * Run from runbook-ai.github.io repo root:
 *   node --test bot/test/
 *
 * The diff matching/annotation logic now lives in
 * auto-chrome/extension/dom-diff.js with its own tests. These tests cover the
 * polling-loop concerns: prevDom propagation, warm-up window, snap.diff
 * surfaced as a SemanticEvent, error handling.
 *
 * monitor.js imports extension.js, which references `chrome.runtime` only
 * inside extensionCall (not at module load), so importing the module is safe
 * in Node. We still install a minimal `globalThis.chrome` stub up front in
 * case future code paths touch it at import time, and we use setActionRunner
 * to inject a fake fetchWebPage when exercising runMonitorPoll.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = globalThis.chrome ?? {
  runtime: {
    sendMessage: async () => { throw new Error('chrome.runtime.sendMessage stub — should not be called in tests'); },
  },
};

const { runMonitorPoll, setActionRunner } = await import('../js/monitor.js');

// Minimal condensed-tree builders. The diff is computed extension-side, so
// these tests don't need realistic trees — just placeholders that round-trip
// through prevDom + are non-falsy on snap.dom.
const dom = (marker) => ({ tag: 'body', attributes: {}, children: [{ text: marker }] });

test('first poll: no prevDom passed, returns [] (warm-up)', async () => {
  const calls = [];
  setActionRunner(async (action, args) => {
    calls.push({ action, args });
    return { dom: dom('first'), url: 'https://x/' };
  });
  try {
    const task = { id: 'mt-warm-1', config: { tabId: 11 } };
    const evs = await runMonitorPoll(task);
    assert.equal(evs.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'fetchWebPage');
    assert.equal(calls[0].args.tabId, 11);
    assert.equal(calls[0].args.prevDom, null, 'first call has no prevDom');
  } finally {
    setActionRunner(null);
  }
});

test('second poll: prevDom from first response is forwarded', async () => {
  const calls = [];
  let next = { dom: dom('A'), url: 'https://x/' };
  setActionRunner(async (action, args) => {
    calls.push({ action, args });
    return next;
  });
  try {
    const task = { id: 'mt-warm-2', config: { tabId: 22 } };
    await runMonitorPoll(task);
    next = { dom: dom('B'), url: 'https://x/' };
    const evs = await runMonitorPoll(task);
    assert.equal(evs.length, 0, 'still in warm-up');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.tabId, 22);
    // Second call's prevDom is whatever the first call returned as snap.dom.
    assert.deepEqual(calls[1].args.prevDom, dom('A'),
      'second call sends first response\'s dom as prevDom');
  } finally {
    setActionRunner(null);
  }
});

test('poll #3 with diff string: surfaced as SemanticEvent', async () => {
  setActionRunner(async () => ({
    dom: dom('latest'),
    url: 'https://example/',
    diff: '<body data-diff="+">change</body>',
  }));
  try {
    const task = { id: 'mt-fire', config: { tabId: 1 } };
    await runMonitorPoll(task); // poll 1, warm-up
    await runMonitorPoll(task); // poll 2, warm-up
    const evs = await runMonitorPoll(task); // poll 3
    assert.equal(evs.length, 1);
    assert.equal(evs[0].text, '<body data-diff="+">change</body>');
    assert.equal(evs[0].source, 'https://example/');
  } finally {
    setActionRunner(null);
  }
});

test('poll #3 with empty diff: no event', async () => {
  setActionRunner(async () => ({ dom: dom('stable'), url: 'https://x/', diff: '' }));
  try {
    const task = { id: 'mt-quiet', config: { tabId: 3 } };
    await runMonitorPoll(task);
    await runMonitorPoll(task);
    const evs = await runMonitorPoll(task);
    assert.deepEqual(evs, []);
  } finally {
    setActionRunner(null);
  }
});

test('poll #3 with diff field absent (no prior change): no event', async () => {
  // The content script omits `diff` entirely when no prevDom was supplied, or
  // when no changes were detected. monitor.js should treat absent the same as
  // empty and not fire.
  setActionRunner(async () => ({ dom: dom('s'), url: 'https://x/' }));
  try {
    const task = { id: 'mt-absent', config: { tabId: 4 } };
    await runMonitorPoll(task);
    await runMonitorPoll(task);
    const evs = await runMonitorPoll(task);
    assert.deepEqual(evs, []);
  } finally {
    setActionRunner(null);
  }
});

test('default tabId=0 when task.config.tabId missing', async () => {
  let observedTabId;
  setActionRunner(async (action, args) => {
    observedTabId = args.tabId;
    return { dom: dom('x'), url: '' };
  });
  try {
    await runMonitorPoll({ id: 'mt-default-tab', config: {} });
    assert.equal(observedTabId, 0);
  } finally {
    setActionRunner(null);
  }
});

test('html-page-not-available error: thrown as descriptive message', async () => {
  setActionRunner(async () => {
    const e = new Error('orig');
    e.code = 'html-page-not-available';
    throw e;
  });
  try {
    const task = { id: 'mt-gone', config: { tabId: 99 } };
    await assert.rejects(
      () => runMonitorPoll(task),
      /no longer available/i
    );
  } finally {
    setActionRunner(null);
  }
});

test('generic fetch error: thrown with tab and underlying message', async () => {
  setActionRunner(async () => { throw new Error('boom'); });
  try {
    const task = { id: 'mt-boom', config: { tabId: 7 } };
    await assert.rejects(
      () => runMonitorPoll(task),
      /Monitor failed to fetch tab 7.*boom/
    );
  } finally {
    setActionRunner(null);
  }
});

test('snap missing dom: descriptive throw', async () => {
  setActionRunner(async () => ({ url: 'https://x/' }));
  try {
    const task = { id: 'mt-no-dom', config: { tabId: 5 } };
    await assert.rejects(
      () => runMonitorPoll(task),
      /no DOM returned/i
    );
  } finally {
    setActionRunner(null);
  }
});

test('null response: descriptive throw', async () => {
  setActionRunner(async () => null);
  try {
    const task = { id: 'mt-null', config: { tabId: 6 } };
    await assert.rejects(
      () => runMonitorPoll(task),
      /no response/i
    );
  } finally {
    setActionRunner(null);
  }
});

test('two tasks share the runner, do not cross-contaminate prevDom', async () => {
  let lastArgs;
  setActionRunner(async (action, args) => {
    lastArgs = args;
    // Each task's tabId distinguishes the response.
    return { dom: dom(`tab${args.tabId}`), url: '' };
  });
  try {
    const a = { id: 'task-a', config: { tabId: 100 } };
    const b = { id: 'task-b', config: { tabId: 200 } };
    await runMonitorPoll(a);
    await runMonitorPoll(b);
    await runMonitorPoll(a);
    // Last call (a's second poll) should have prevDom = first a-response.
    assert.deepEqual(lastArgs.prevDom, dom('tab100'),
      'task-a\'s second poll references task-a\'s first response, not task-b\'s');
    assert.equal(lastArgs.tabId, 100);
  } finally {
    setActionRunner(null);
  }
});

/**
 * Tests for monitor-ui.js pure helpers.
 *
 * monitor-ui.js imports from task-store/task-manager but only references the
 * browser DOM lazily inside startMonitorUI. The pure formatters/sort helpers
 * exercised here have no side effects and don't touch the DOM, so we just
 * stub localStorage (transitively required by settings.js → monitor-ui's
 * dep chain) and import directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem: () => {} };

const { formatMs, timeAgo, timeUntil, sortKey, dotClass, line2Text } =
  await import('../js/monitor-ui.js');

// ── formatMs (Math.floor variant — see monitor-ui.js:13) ────────────────────

test('formatMs: 0 / null / negative → "?"', () => {
  assert.equal(formatMs(0), '?');
  assert.equal(formatMs(null), '?');
  assert.equal(formatMs(undefined), '?');
  assert.equal(formatMs(-100), '?');
});

test('formatMs: seconds (< 1m)', () => {
  assert.equal(formatMs(1000), '1s');
  assert.equal(formatMs(45_000), '45s');
  assert.equal(formatMs(59_999), '59s');
});

test('formatMs: minutes', () => {
  assert.equal(formatMs(60_000), '1m');
  assert.equal(formatMs(120_000), '2m');
  assert.equal(formatMs(3_599_999), '59m');
});

test('formatMs: hours', () => {
  assert.equal(formatMs(3_600_000), '1h');
  assert.equal(formatMs(2 * 3_600_000), '2h');
  assert.equal(formatMs(86_399_999), '23h');
});

test('formatMs: days', () => {
  assert.equal(formatMs(86_400_000), '1d');
  assert.equal(formatMs(7 * 86_400_000), '7d');
});

// ── timeAgo / timeUntil ─────────────────────────────────────────────────────

test('timeAgo: empty / null → ""', () => {
  assert.equal(timeAgo(null), '');
  assert.equal(timeAgo(''), '');
});

test('timeAgo: < 5s → "just now"', () => {
  const now = new Date(Date.now() - 2000).toISOString();
  assert.equal(timeAgo(now), 'just now');
});

test('timeAgo: older returns "<formatted> ago"', () => {
  const t = new Date(Date.now() - 90_000).toISOString();
  const out = timeAgo(t);
  assert.match(out, /^1m ago$/);
});

test('timeUntil: empty / null → ""', () => {
  assert.equal(timeUntil(null), '');
  assert.equal(timeUntil(''), '');
});

test('timeUntil: past or now → "now"', () => {
  assert.equal(timeUntil(new Date(Date.now() - 5000).toISOString()), 'now');
  assert.equal(timeUntil(new Date(Date.now()).toISOString()), 'now');
});

test('timeUntil: future returns "in <formatted>"', () => {
  const t = new Date(Date.now() + 90_000).toISOString();
  assert.match(timeUntil(t), /^in 1m$/);
});

// ── sortKey ─────────────────────────────────────────────────────────────────

test('sortKey: monitor + waiting maps to "watching" slot (2)', () => {
  assert.equal(sortKey({ type: 'monitor', status: 'waiting' }), 2);
});

test('sortKey: regular waiting task maps to slot 3', () => {
  assert.equal(sortKey({ status: 'waiting' }), 3);
});

test('sortKey: running < queued < watching < waiting < paused', () => {
  const order = [
    sortKey({ status: 'running' }),                      // 0
    sortKey({ status: 'queued' }),                       // 1
    sortKey({ type: 'monitor', status: 'waiting' }),     // 2
    sortKey({ status: 'waiting' }),                      // 3
    sortKey({ status: 'paused' }),                       // 4
  ];
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('sortKey: unknown status falls through to 5', () => {
  assert.equal(sortKey({ status: 'completed' }), 5);
  assert.equal(sortKey({ status: 'whatever' }), 5);
});

// ── dotClass ────────────────────────────────────────────────────────────────

test('dotClass: running task', () => {
  assert.equal(dotClass({ status: 'running' }), 'agent-dot--running');
});

test('dotClass: queued task', () => {
  assert.equal(dotClass({ status: 'queued' }), 'agent-dot--queued');
});

test('dotClass: monitor in waiting → watching variant', () => {
  assert.equal(dotClass({ type: 'monitor', status: 'waiting' }), 'agent-dot--watching');
});

test('dotClass: regular waiting → waiting variant', () => {
  assert.equal(dotClass({ status: 'waiting' }), 'agent-dot--waiting');
});

test('dotClass: paused / fallback → paused variant', () => {
  assert.equal(dotClass({ status: 'paused' }), 'agent-dot--paused');
  assert.equal(dotClass({ status: 'unknown' }), 'agent-dot--paused');
});

// ── line2Text ───────────────────────────────────────────────────────────────

test('line2Text: monitor with poll interval', () => {
  const t = { type: 'monitor', schedule: { intervalMs: 60_000 } };
  assert.equal(line2Text(t), 'Watch · polls every 1m');
});

test('line2Text: monitor with last poll time', () => {
  const t = {
    type: 'monitor',
    schedule: { intervalMs: 120_000 },
    lastRunAt: new Date(Date.now() - 30_000).toISOString(),
  };
  assert.match(line2Text(t), /^Watch · polls every 2m · polled \d+s ago$/);
});

test('line2Text: scheduled task waiting with nextRunAt', () => {
  const t = {
    schedule: { intervalMs: 60_000 },
    status: 'waiting',
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.match(line2Text(t), /^Scheduled · every 1m · next in 1m$/);
});

test('line2Text: scheduled task running shows last run time', () => {
  const t = {
    schedule: { intervalMs: 60_000 },
    status: 'running',
    lastRunAt: new Date(Date.now() - 5_000).toISOString(),
  };
  assert.match(line2Text(t), /^Scheduled · every 1m · running /);
});

test('line2Text: queued one-shot task', () => {
  assert.equal(line2Text({ status: 'queued' }), 'Task · queued');
});

test('line2Text: running one-shot task', () => {
  const t = { status: 'running', lastRunAt: new Date(Date.now() - 1000).toISOString() };
  assert.match(line2Text(t), /^Task · running /);
});

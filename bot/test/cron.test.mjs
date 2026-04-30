/**
 * Tests for cron.js pure helpers (computeNextRun, computeBackoff).
 *
 * cron.js imports task-store.js, which only touches `indexedDB` inside
 * function bodies — module load is safe in Node. The helpers under test
 * here are pure and independent of the timer/IndexedDB plumbing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { computeNextRun, computeBackoff } = await import('../js/cron.js');

// ── computeNextRun ──────────────────────────────────────────────────────────

test('computeNextRun: null schedule → null', () => {
  assert.equal(computeNextRun(null), null);
  assert.equal(computeNextRun(undefined), null);
});

test('computeNextRun: every adds intervalMs to fromMs', () => {
  const from = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z
  const r = computeNextRun({ type: 'every', intervalMs: 60_000 }, from);
  assert.equal(r, '2026-01-01T00:01:00.000Z');
});

test('computeNextRun: every with hour interval', () => {
  const from = Date.UTC(2026, 5, 15, 12, 0, 0);
  const r = computeNextRun({ type: 'every', intervalMs: 3_600_000 * 2 }, from);
  assert.equal(r, '2026-06-15T14:00:00.000Z');
});

test('computeNextRun: at returns the time when in the future', () => {
  const from = Date.UTC(2026, 0, 1);
  const future = '2026-12-31T23:59:59.000Z';
  assert.equal(computeNextRun({ type: 'at', time: future }, from), future);
});

test('computeNextRun: at returns null when in the past', () => {
  const from = Date.UTC(2026, 5, 1);
  const past = '2026-01-01T00:00:00.000Z';
  assert.equal(computeNextRun({ type: 'at', time: past }, from), null);
});

test('computeNextRun: at returns null when exactly equal to now', () => {
  const t = '2026-06-15T12:00:00.000Z';
  const from = new Date(t).getTime();
  // The check is `t > fromMs`, so equal is treated as past.
  assert.equal(computeNextRun({ type: 'at', time: t }, from), null);
});

test('computeNextRun: unknown schedule type → null', () => {
  assert.equal(computeNextRun({ type: 'cron', expr: '* * * * *' }), null);
  assert.equal(computeNextRun({ type: 'bogus' }), null);
});

test('computeNextRun: defaults fromMs to Date.now()', () => {
  const before = Date.now();
  const r = computeNextRun({ type: 'every', intervalMs: 1000 });
  const after = Date.now();
  const t = new Date(r).getTime();
  assert.ok(t >= before + 1000 && t <= after + 1000, `expected within [${before+1000}, ${after+1000}], got ${t}`);
});

// ── computeBackoff ──────────────────────────────────────────────────────────
// Steps: [30s, 1m, 5m, 15m, 60m]. Index = min(consecutiveErrors, len) - 1, floored at 0.

test('computeBackoff: 0 errors → 30s (floored to first step)', () => {
  assert.equal(computeBackoff(0), 30_000);
});

test('computeBackoff: 1 error → 30s (first step)', () => {
  assert.equal(computeBackoff(1), 30_000);
});

test('computeBackoff: 2 errors → 1m', () => {
  assert.equal(computeBackoff(2), 60_000);
});

test('computeBackoff: 3 errors → 5m', () => {
  assert.equal(computeBackoff(3), 300_000);
});

test('computeBackoff: 4 errors → 15m', () => {
  assert.equal(computeBackoff(4), 900_000);
});

test('computeBackoff: 5 errors → 60m (cap)', () => {
  assert.equal(computeBackoff(5), 3_600_000);
});

test('computeBackoff: >5 errors stays at 60m cap', () => {
  assert.equal(computeBackoff(10), 3_600_000);
  assert.equal(computeBackoff(100), 3_600_000);
});

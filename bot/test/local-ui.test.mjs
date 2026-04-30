/**
 * Tests for local-ui.js pure helpers (normalizeId, parseInterval, formatMs).
 *
 * local-ui.js calls initDom() at module load and reaches into the DOM via
 * document.getElementById. We provide minimal stubs for `document` and
 * `localStorage` so the module loads cleanly in Node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem: () => {} };
globalThis.document = globalThis.document ?? {
  readyState: 'complete',
  getElementById: () => null,
  addEventListener: () => {},
  querySelector: () => null,
};

const { normalizeId, parseInterval, formatMs } = await import('../js/local-ui.js');

// ── normalizeId ─────────────────────────────────────────────────────────────

test('normalizeId: trims whitespace', () => {
  assert.equal(normalizeId('  abc123  '), 'abc123');
});

test('normalizeId: strips backticks (Discord/Markdown code-quote)', () => {
  assert.equal(normalizeId('`abc123`'), 'abc123');
});

test('normalizeId: strips single and double quotes', () => {
  assert.equal(normalizeId(`'abc123'`), 'abc123');
  assert.equal(normalizeId(`"abc123"`), 'abc123');
});

test('normalizeId: strips multiple wrapping quote chars on each side', () => {
  assert.equal(normalizeId('```abc123```'), 'abc123');
  assert.equal(normalizeId(`'"\`abc123\`"'`), 'abc123');
});

test('normalizeId: only strips wrapping quotes — interior preserved', () => {
  assert.equal(normalizeId('a`b`c'), 'a`b`c');
});

test('normalizeId: null / undefined → empty string', () => {
  assert.equal(normalizeId(null), '');
  assert.equal(normalizeId(undefined), '');
});

// ── parseInterval ───────────────────────────────────────────────────────────

test('parseInterval: seconds', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('1s'), 1_000);
});

test('parseInterval: minutes', () => {
  assert.equal(parseInterval('1m'), 60_000);
  assert.equal(parseInterval('30m'), 1_800_000);
});

test('parseInterval: hours', () => {
  assert.equal(parseInterval('1h'), 3_600_000);
  assert.equal(parseInterval('2h'), 7_200_000);
});

test('parseInterval: days', () => {
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.equal(parseInterval('7d'), 7 * 86_400_000);
});

test('parseInterval: case-insensitive unit', () => {
  assert.equal(parseInterval('30M'), 1_800_000);
  assert.equal(parseInterval('1H'),  3_600_000);
  assert.equal(parseInterval('1D'),  86_400_000);
});

test('parseInterval: decimals are rounded to nearest ms', () => {
  assert.equal(parseInterval('1.5m'), 90_000);
  assert.equal(parseInterval('0.5h'), 1_800_000);
});

test('parseInterval: whitespace between number and unit allowed', () => {
  assert.equal(parseInterval('5 m'), 300_000);
});

test('parseInterval: invalid input → null', () => {
  assert.equal(parseInterval(''), null);
  assert.equal(parseInterval('5'), null);             // no unit
  assert.equal(parseInterval('m'), null);             // no number
  assert.equal(parseInterval('5x'), null);            // bad unit
  assert.equal(parseInterval('every 5m'), null);      // extra prefix
  assert.equal(parseInterval('5m foo'), null);        // trailing junk
});

// ── formatMs (toFixed-trim variant — see local-ui.js:35) ────────────────────

test('formatMs: seconds (< 1m)', () => {
  assert.equal(formatMs(0),       '0s');
  assert.equal(formatMs(1_000),   '1s');
  assert.equal(formatMs(45_000),  '45s');
});

test('formatMs: whole minutes drop the ".0"', () => {
  assert.equal(formatMs(60_000),   '1m');
  assert.equal(formatMs(120_000),  '2m');
});

test('formatMs: fractional minutes keep one decimal', () => {
  assert.equal(formatMs(90_000),   '1.5m');
  assert.equal(formatMs(150_000),  '2.5m');
});

test('formatMs: whole hours drop the ".0"', () => {
  assert.equal(formatMs(3_600_000),     '1h');
  assert.equal(formatMs(2 * 3_600_000), '2h');
});

test('formatMs: fractional hours keep one decimal', () => {
  assert.equal(formatMs(5_400_000), '1.5h');
});

test('formatMs: whole days drop the ".0"', () => {
  assert.equal(formatMs(86_400_000),     '1d');
  assert.equal(formatMs(7 * 86_400_000), '7d');
});

test('formatMs: fractional days keep one decimal', () => {
  assert.equal(formatMs(86_400_000 * 1.5), '1.5d');
});

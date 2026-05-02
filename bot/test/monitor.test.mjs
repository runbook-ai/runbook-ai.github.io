/**
 * Tests for monitor.js diff logic.
 *
 * Run from runbook-ai.github.io repo root:
 *   node --test bot/test/
 *
 * monitor.js imports extension.js, which references `chrome.runtime` only
 * inside extensionCall (not at module load), so importing the module is safe
 * in Node. We still install a minimal `globalThis.chrome` stub up front in
 * case future code paths touch it at import time, and we use setActionRunner
 * to inject a fake fetchWebPage when exercising runMonitorPoll.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.runtime mock — installed BEFORE importing monitor.js.
globalThis.chrome = globalThis.chrome ?? {
  runtime: {
    sendMessage: async () => { throw new Error('chrome.runtime.sendMessage stub — should not be called in tests'); },
  },
};

const { unifiedDiff, runMonitorPoll, setActionRunner } = await import('../js/monitor.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

const mk = (tag, attrs, ...children) => ({ tag, attributes: attrs, children });
const txt = (s) => ({ text: s });

// unifiedDiff calls calculateHashes which mutates nodes — clone before each call
// so reuse across cases doesn't pollute hashes.
const clone = (n) => JSON.parse(JSON.stringify(n));

const diff = (cur, prev) => unifiedDiff(clone(cur), clone(prev));
const hasAdd = (d, s) => d.split('\n').some(l => l.startsWith('+') && l.includes(s));
const hasRem = (d, s) => d.split('\n').some(l => l.startsWith('-') && l.includes(s));

// ── selfHash semantic-attribute coverage ────────────────────────────────────

test('href change on <a> produces a diff', () => {
  const prev = mk('body', {}, mk('a', { href: '/old' }, txt('click here')));
  const cur  = mk('body', {}, mk('a', { href: '/new' }, txt('click here')));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'href="/new"'), `expected + line with /new, got:\n${d}`);
  assert.ok(hasRem(d, 'href="/old"'), `expected - line with /old, got:\n${d}`);
});

test('src change on <img> produces a diff', () => {
  const prev = mk('body', {}, mk('img', { src: '/a.png', alt: 'pic' }));
  const cur  = mk('body', {}, mk('img', { src: '/b.png', alt: 'pic' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'src="/b.png"'));
  assert.ok(hasRem(d, 'src="/a.png"'));
});

test('alt change on <img> produces a diff', () => {
  const prev = mk('body', {}, mk('img', { src: '/x.png', alt: 'old caption' }));
  const cur  = mk('body', {}, mk('img', { src: '/x.png', alt: 'new caption' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'alt="new caption"'));
  assert.ok(hasRem(d, 'alt="old caption"'));
});

test('aria-label change on icon button produces a diff', () => {
  const prev = mk('body', {}, mk('button', { 'aria-label': 'Open menu' }));
  const cur  = mk('body', {}, mk('button', { 'aria-label': 'Close menu' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'aria-label="Close menu"'));
  assert.ok(hasRem(d, 'aria-label="Open menu"'));
});

test('role change produces a diff', () => {
  const prev = mk('body', {}, mk('div', { role: 'button' }, txt('Go')));
  const cur  = mk('body', {}, mk('div', { role: 'link' },   txt('Go')));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'role="link"'));
  assert.ok(hasRem(d, 'role="button"'));
});

test('input type change (text → password) produces a diff', () => {
  const prev = mk('body', {}, mk('input', { type: 'text',     name: 'pw' }));
  const cur  = mk('body', {}, mk('input', { type: 'password', name: 'pw' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'type="password"'));
  assert.ok(hasRem(d, 'type="text"'));
});

test('disabled toggle produces a diff', () => {
  const prev = mk('body', {}, mk('button', { type: 'submit', disabled: 'true' }, txt('Save')));
  const cur  = mk('body', {}, mk('button', { type: 'submit' },                   txt('Save')));
  const d = diff(cur, prev);
  assert.ok(hasRem(d, 'disabled="true"'));
});

test('checked toggle produces a diff', () => {
  const prev = mk('body', {}, mk('input', { type: 'checkbox' }));
  const cur  = mk('body', {}, mk('input', { type: 'checkbox', checked: 'true' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'checked="true"'));
});

test('placeholder change produces a diff', () => {
  const prev = mk('body', {}, mk('input', { type: 'text', placeholder: 'Search…' }));
  const cur  = mk('body', {}, mk('input', { type: 'text', placeholder: 'Find anything' }));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'placeholder="Find anything"'));
  assert.ok(hasRem(d, 'placeholder="Search…"'));
});

// ── Excluded attributes (must NOT diff) ─────────────────────────────────────

test('class change is ignored', () => {
  const prev = mk('body', {}, mk('a', { href: '/x', class: 'btn' },        txt('go')));
  const cur  = mk('body', {}, mk('a', { href: '/x', class: 'btn active' }, txt('go')));
  assert.equal(diff(cur, prev), '');
});

test('data-* change is ignored', () => {
  const prev = mk('body', {}, mk('div', { 'data-key': 'r1', class: 'row' }, txt('A')));
  const cur  = mk('body', {}, mk('div', { 'data-key': 'r2', class: 'row' }, txt('A')));
  assert.equal(diff(cur, prev), '');
});

test('id change is ignored', () => {
  const prev = mk('body', {}, mk('div', { id: 'a1' }, txt('Hello')));
  const cur  = mk('body', {}, mk('div', { id: 'a2' }, txt('Hello')));
  assert.equal(diff(cur, prev), '');
});

test('style change is ignored', () => {
  const prev = mk('body', {}, mk('div', { style: 'color: red' },  txt('Hi')));
  const cur  = mk('body', {}, mk('div', { style: 'color: blue' }, txt('Hi')));
  assert.equal(diff(cur, prev), '');
});

// ── Text and structure diffs (orthogonal to selfHash change) ────────────────

test('text change in a leaf produces a diff', () => {
  const prev = mk('body', {}, mk('h1', {}, txt('Example Domain')));
  const cur  = mk('body', {}, mk('h1', {}, txt('Changed Heading')));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'Changed Heading'));
  assert.ok(hasRem(d, 'Example Domain'));
});

test('identical trees produce empty diff', () => {
  const tree = mk('body', {}, mk('a', { href: '/x' }, txt('go')));
  assert.equal(diff(tree, tree), '');
});

test('added child surfaces as +', () => {
  const prev = mk('body', {}, mk('p', {}, txt('one')));
  const cur  = mk('body', {}, mk('p', {}, txt('one')), mk('p', {}, txt('two')));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'two'));
  assert.ok(!hasRem(d, 'one'));
});

test('removed child surfaces as -', () => {
  const prev = mk('body', {}, mk('p', {}, txt('one')), mk('p', {}, txt('two')));
  const cur  = mk('body', {}, mk('p', {}, txt('one')));
  const d = diff(cur, prev);
  assert.ok(hasRem(d, 'two'));
});

// ── DiffNode kinds and combinations ─────────────────────────────────────────
// These exercise the buildDiff/renderDiff paths directly: 'replace' (root tag
// change, leaf-vs-element), 'wrapper' (with multiple changed children, nested,
// rollback via reorder), textarea values, and the cur-paired-then-prev-tail
// child ordering.

test('replace at root: different root tag emits whole prev as - and whole cur as +', () => {
  const prev = mk('body', {}, mk('p', {}, txt('hi')));
  const cur  = mk('main', {}, mk('p', {}, txt('hi')));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.ok(lines.every(l => l.startsWith('+') || l.startsWith('-')),
    `expected only +/- lines (no wrapper context), got:\n${d}`);
  assert.ok(hasRem(d, '<body'));
  assert.ok(hasAdd(d, '<main'));
});

test('replace: top-level leaf-vs-element renders prev whole as -, cur whole as +', () => {
  const prev = txt('hi');
  const cur  = mk('p', {}, txt('hi'));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.ok(lines.every(l => l[0] === '-' || l[0] === '+'),
    `expected only +/- lines, got:\n${d}`);
  const minusLines = lines.filter(l => l[0] === '-');
  const plusLines  = lines.filter(l => l[0] === '+');
  assert.equal(minusLines.length, 1, `prev text leaf should be one '-' line`);
  assert.ok(minusLines[0].includes('hi'));
  assert.equal(plusLines.length, 3, `cur <p>hi</p> should render as 3 '+' lines`);
  assert.ok(plusLines[0].includes('<p'));
  assert.ok(plusLines[1].includes('hi'));
  assert.ok(plusLines[2].includes('</p>'));
  assert.ok(d.indexOf('-') < d.indexOf('+'));
});

test('replace: top-level element-vs-leaf renders prev whole as -, cur whole as +', () => {
  const prev = mk('p', {}, txt('hi'));
  const cur  = txt('hi');
  const d = diff(cur, prev);
  const lines = d.split('\n');
  const minusLines = lines.filter(l => l[0] === '-');
  const plusLines  = lines.filter(l => l[0] === '+');
  assert.equal(minusLines.length, 3);
  assert.equal(plusLines.length, 1);
  assert.ok(plusLines[0].includes('hi'));
});

test('top-level text-only diff renders as - / +', () => {
  const d = diff(txt('world'), txt('hello'));
  assert.equal(d, '-hello\n+world');
});

test('wrapper: open/close emitted as context, unchanged siblings dropped', () => {
  const prev = mk('body', {}, mk('p', {}, txt('one')), mk('p', {}, txt('two')));
  const cur  = mk('body', {}, mk('p', {}, txt('one')), mk('p', {}, txt('CHANGED')));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.ok(lines[0].startsWith(' ') && lines[0].includes('<body'),
    `body open should be ' '-context, got: ${lines[0]}`);
  assert.ok(lines[lines.length - 1].startsWith(' ') && lines[lines.length - 1].includes('</body>'),
    `body close should be ' '-context, got: ${lines[lines.length - 1]}`);
  assert.ok(!d.includes('one'), `unchanged sibling 'one' must not appear, got:\n${d}`);
  assert.ok(hasRem(d, 'two'));
  assert.ok(hasAdd(d, 'CHANGED'));
});

test('wrapper: nested wrappers preserve ancestor-only context', () => {
  const prev = mk('body', {}, mk('section', {}, mk('p', {}, txt('A'))));
  const cur  = mk('body', {}, mk('section', {}, mk('p', {}, txt('B'))));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.ok(lines[0].includes('<body') && lines[0].startsWith(' '));
  assert.ok(lines[1].includes('<section') && lines[1].startsWith(' '));
  assert.ok(lines[2].includes('<p') && lines[2].startsWith(' '));
  assert.ok(lines.some(l => l.startsWith('+') && l.includes('B')));
  assert.ok(lines.some(l => l.startsWith('-') && l.includes('A')));
  assert.ok(lines.at(-3).includes('</p>'));
  assert.ok(lines.at(-2).includes('</section>'));
  assert.ok(lines.at(-1).includes('</body>'));
});

test('wrapper: cur-paired children before unpaired prev-tail removals', () => {
  // Use distinct tags for added vs removed so neither pairs by selfHash with
  // the other — added go to cur-order list, removed go to prev-tail.
  const prev = mk('body', {},
    mk('p', {}, txt('keep')),
    mk('div', { class: 'a' }, txt('drop1')),
    mk('div', { class: 'b' }, txt('drop2')),
  );
  const cur = mk('body', {},
    mk('p', {}, txt('keep')),
    mk('span', {}, txt('add1')),
    mk('span', {}, txt('add2')),
  );
  const d = diff(cur, prev);
  assert.ok(!d.includes('keep'));
  assert.ok(d.indexOf('add1') < d.indexOf('add2'),  'cur additions in cur order');
  assert.ok(d.indexOf('drop1') < d.indexOf('drop2'), 'prev-tail removals in prev order');
  assert.ok(d.indexOf('add2') < d.indexOf('drop1'),
    'all cur-order additions before prev-tail removals');
});

test('wrapper rollback: pure reorder of identical children → empty diff', () => {
  // Each <p> pairs by fullHash with the matching <p> in prev — every child
  // returns null, body wrapper has no children, rollback triggers.
  const prev = mk('body', {}, mk('p', {}, txt('a')), mk('p', {}, txt('b')));
  const cur  = mk('body', {}, mk('p', {}, txt('b')), mk('p', {}, txt('a')));
  assert.equal(diff(cur, prev), '');
});

test('text leaves with different content under same wrapper become added + removed', () => {
  // Inside child matching, text leaves only pair when content is identical
  // (their hash and selfHash both equal hashString(text)), so a changed-text-
  // in-same-position case becomes added(cur) + removed(prev) — adds in cur
  // order first, then unpaired prev tail.
  const prev = mk('body', {}, mk('p', {}, txt('hello')));
  const cur  = mk('body', {}, mk('p', {}, txt('world')));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.equal(lines.length, 6, `unexpected line count, got:\n${d}`);
  assert.equal(lines[2][0], '+');
  assert.equal(lines[3][0], '-');
  assert.ok(lines[2].includes('world'));
  assert.ok(lines[3].includes('hello'));
});

test('mixed: add + remove + content change in one wrapper', () => {
  const prev = mk('body', {},
    mk('p', {}, txt('keep')),
    mk('p', {}, txt('change me')),
    mk('div', {}, txt('to remove')),  // div tag → won't pair with span
  );
  const cur = mk('body', {},
    mk('p', {}, txt('keep')),
    mk('p', {}, txt('changed!')),
    mk('span', {}, txt('newly added')),
  );
  const d = diff(cur, prev);
  assert.ok(!d.includes('keep'));
  assert.ok(hasRem(d, 'change me'));
  assert.ok(hasAdd(d, 'changed!'));
  assert.ok(hasAdd(d, 'newly added'));
  assert.ok(hasRem(d, 'to remove'));
});

test('textarea value change surfaces as element replace', () => {
  const ta = (v) => ({ tag: 'textarea', attributes: {}, value: v, children: [] });
  const prev = mk('body', {}, ta('before'));
  const cur  = mk('body', {}, ta('after'));
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'after'),  `expected + with new value, got:\n${d}`);
  assert.ok(hasRem(d, 'before'), `expected - with old value, got:\n${d}`);
});

test('wrapper: unchanged textarea value emitted as context line on inner change', () => {
  // Pair the textareas by selfHash (same value), force a child-level change
  // by adding an inner element. Verifies the hasTextareaValue ' '-context path.
  const ta = (v, ...kids) => ({ tag: 'textarea', attributes: {}, value: v, children: kids });
  const prev = mk('body', {}, ta('same', mk('span', {}, txt('a'))));
  const cur  = mk('body', {}, ta('same', mk('span', {}, txt('b'))));
  const d = diff(cur, prev);
  const lines = d.split('\n');
  assert.ok(lines.some(l => l.startsWith(' ') && l.includes('same')),
    `expected ' '-context line with textarea value, got:\n${d}`);
  assert.ok(hasAdd(d, 'b'));
  assert.ok(hasRem(d, 'a'));
});

// ── runMonitorPoll with mocked fetchWebPage ─────────────────────────────────

test('runMonitorPoll: baseline + warmup return [], post-warmup fires on change', async () => {
  const baseline = mk('body', {}, mk('a', { href: '/old' }, txt('click')));
  const changed  = mk('body', {}, mk('a', { href: '/new' }, txt('click')));

  // Inject a fake action runner that returns whatever DOM we set on the closure.
  let next;
  setActionRunner(async (action, args) => {
    assert.equal(action, 'fetchWebPage');
    return { dom: clone(next), url: 'https://test/' };
  });

  const task = { id: 'mt1', config: { tabId: 1 } };

  next = baseline;
  assert.deepEqual(await runMonitorPoll(task), [], 'poll #1 (baseline) should return []');

  next = baseline;
  assert.deepEqual(await runMonitorPoll(task), [], 'poll #2 (warmup) should return []');

  next = changed;
  const evs = await runMonitorPoll(task);
  assert.equal(evs.length, 1, 'poll #3 with change should fire');
  assert.ok(evs[0].text.includes('href="/new"'));
  assert.ok(evs[0].text.includes('href="/old"'));
  assert.equal(evs[0].source, 'https://test/');

  // Restore default runner so other tests in the same process don't see the stub.
  setActionRunner(null);
});

test('runMonitorPoll: post-warmup with no change returns []', async () => {
  const stable = mk('body', {}, mk('p', {}, txt('hello')));
  setActionRunner(async () => ({ dom: clone(stable), url: 'https://test/' }));
  const task = { id: 'mt2', config: { tabId: 2 } };
  await runMonitorPoll(task); // baseline
  await runMonitorPoll(task); // warmup
  assert.deepEqual(await runMonitorPoll(task), []);
  setActionRunner(null);
});

// ── Order-proof matching tests ──────────────────────────────────────────────

function makeItem(name, avatarSrc, timestamp, message) {
  return mk('div', {},
    mk('div', {},
      mk('div', {}, mk('img', { src: avatarSrc })),
      mk('div', {}, txt(name)),
      mk('span', {}, txt(timestamp)),
    ),
    mk('div', {}, txt(message)),
  );
}

function wrap(items) {
  return mk('body', {}, mk('div', {}, ...items));
}

function countPrefixed(d, prefix) {
  if (!d) return 0;
  return d.split('\n').filter(l => l.startsWith(prefix)).length;
}

test('swap: reordered items produce only timestamp diffs', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
  ]);
  const cur = wrap([
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
    makeItem('Alice', 'alice.png', '6 mins', 'Hello'),
  ]);
  const d = diff(cur, prev);
  assert.ok(!hasAdd(d, 'Alice'), 'Alice not in + lines');
  assert.ok(!hasRem(d, 'Alice'), 'Alice not in - lines');
  assert.ok(!hasAdd(d, 'Bob'), 'Bob not in + lines');
  assert.ok(!hasRem(d, 'Bob'), 'Bob not in - lines');
  assert.ok(countPrefixed(d, '+') <= 4, `swap: added ≤ 4 (got ${countPrefixed(d, '+')})`);
  assert.ok(countPrefixed(d, '-') <= 4, `swap: removed ≤ 4 (got ${countPrefixed(d, '-')})`);
});

test('new item added at top with reorder', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
  ]);
  const cur = wrap([
    makeItem('Charlie', 'charlie.png', '1 min', 'New message'),
    makeItem('Alice', 'alice.png', '6 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
  ]);
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'Charlie'), 'Charlie appears as added');
  assert.ok(hasAdd(d, 'New message'), 'New message appears');
  assert.ok(!hasAdd(d, 'Alice'), 'Alice not shown as added');
  assert.ok(!hasRem(d, 'Alice'), 'Alice not shown as removed');
});

test('item removed from list', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
  ]);
  const cur = wrap([
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
  ]);
  const d = diff(cur, prev);
  assert.ok(hasRem(d, 'Alice'), 'Alice shown as removed');
  assert.ok(!hasAdd(d, 'Bob'), 'Bob not shown as added');
});

test('content change with reorder: only changed text in diff', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Old message'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
  ]);
  const cur = wrap([
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
    makeItem('Alice', 'alice.png', '6 mins', 'New reply in thread'),
  ]);
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'New reply in thread'), 'New content appears');
  assert.ok(hasRem(d, 'Old message'), 'Old content shown as removed');
  assert.ok(!hasAdd(d, 'Bob'), 'Bob not in + lines');
  assert.ok(!hasRem(d, 'Bob'), 'Bob not in - lines');
});

test('new item + reorder + content change combined', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
    makeItem('Charlie', 'charlie.png', '15 mins', 'Old msg'),
  ]);
  const cur = wrap([
    makeItem('Diana', 'diana.png', '1 min', 'Brand new'),
    makeItem('Charlie', 'charlie.png', '16 mins', 'Updated msg'),
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
    makeItem('Alice', 'alice.png', '6 mins', 'Hello'),
  ]);
  const d = diff(cur, prev);
  assert.ok(hasAdd(d, 'Diana'), 'Diana (new) appears');
  assert.ok(hasAdd(d, 'Brand new'), 'New message appears');
  assert.ok(hasAdd(d, 'Updated msg'), 'Updated content appears');
  assert.ok(!hasAdd(d, 'Alice'), 'Alice not in + lines');
  assert.ok(!hasRem(d, 'Alice'), 'Alice not in - lines');
  assert.ok(!hasAdd(d, 'Bob'), 'Bob not in + lines');
  assert.ok(!hasRem(d, 'Bob'), 'Bob not in - lines');
});

test('timestamp-only changes produce minimal diff', () => {
  const prev = wrap([
    makeItem('Alice', 'alice.png', '5 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '10 mins', 'World'),
  ]);
  const cur = wrap([
    makeItem('Alice', 'alice.png', '6 mins', 'Hello'),
    makeItem('Bob', 'bob.png', '11 mins', 'World'),
  ]);
  const d = diff(cur, prev);
  assert.equal(countPrefixed(d, '+'), 2, 'exactly 2 added lines');
  assert.equal(countPrefixed(d, '-'), 2, 'exactly 2 removed lines');
});

/**
 * Tests for event-store.js — dedup, cursor semantics, GC, topic listing.
 *
 * Run from runbook-ai.github.io repo root:
 *   node --test bot/test/event-store.test.mjs
 *
 * event-store imports file-store, which uses indexedDB. We install a
 * minimal in-memory IDB shim that's just-good-enough for file-store's
 * actual usage (open / transaction / objectStore.get|put|delete|getAll
 * keyed on `path`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal in-memory IndexedDB shim ───────────────────────────────────────
//
// file-store opens `runbookai_files` and uses one object store `files`
// keyed on `path`. That's the entire surface area we need to emulate.

function installFakeIDB() {
  const stores = new Map(); // dbName -> Map<storeName, Map<key, value>>

  function fireSuccess(req, result) {
    req.result = result;
    queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req }));
  }

  function makeObjectStore(map) {
    return {
      get(key) {
        const req = {};
        fireSuccess(req, map.get(key));
        return req;
      },
      put(record) {
        const req = {};
        map.set(record.path, { ...record });
        fireSuccess(req, record.path);
        return req;
      },
      delete(key) {
        const req = {};
        map.delete(key);
        fireSuccess(req, undefined);
        return req;
      },
      getAll() {
        const req = {};
        fireSuccess(req, Array.from(map.values()));
        return req;
      },
    };
  }

  globalThis.indexedDB = {
    open(name /*, version */) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
      if (!stores.has(name)) stores.set(name, new Map());
      const storeMap = stores.get(name);
      if (!storeMap.has('files')) storeMap.set('files', new Map());

      const db = {
        objectStoreNames: { contains: (s) => storeMap.has(s) },
        createObjectStore: (s) => {
          if (!storeMap.has(s)) storeMap.set(s, new Map());
          return makeObjectStore(storeMap.get(s));
        },
        transaction: (storeName /*, mode */) => ({
          objectStore: (s) => makeObjectStore(storeMap.get(s || storeName)),
        }),
      };
      req.result = db;
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };

  return {
    // Clear data IN PLACE so file-store's cached `dbPromise` keeps working.
    // (file-store memoizes its db connection on first use; if we replaced the
    // backing Maps, the cached db would still point to the old ones.)
    reset() {
      for (const storeMap of stores.values()) {
        for (const inner of storeMap.values()) inner.clear();
      }
    },
  };
}

const fakeIDB = installFakeIDB();

const ev = await import('../js/event-store.js');
const fs = await import('../js/file-store.js');

// Helper: clear the IDB between tests.
function resetIDB() {
  fakeIDB.reset();
}

// ── appendEvent ────────────────────────────────────────────────────────────

test('appendEvent writes a JSON line with ts; sourceTaskId stored when provided', async () => {
  resetIDB();
  const row = await ev.appendEvent({ topic: 't.a', payload: { x: 1 }, sourceTaskId: 'task_123' });
  assert.ok(row.ts, 'ts is set');
  assert.deepEqual(row.payload, { x: 1 });
  assert.equal(row.sourceTaskId, 'task_123');
  assert.equal(row.dedupKey, undefined);

  const file = await fs.readFile('events/t.a.jsonl');
  assert.ok(file, 'file written');
  const parsed = JSON.parse(file.content.trim());
  assert.equal(parsed.payload.x, 1);
});

test('appendEvent throws on missing topic', async () => {
  resetIDB();
  await assert.rejects(() => ev.appendEvent({ payload: {} }), /topic is required/);
});

// ── Dedup ──────────────────────────────────────────────────────────────────

test('dedup: same (topic, dedupKey) within 24h returns the existing row, no new line', async () => {
  resetIDB();
  const first  = await ev.appendEvent({ topic: 't.dup', payload: { v: 1 }, dedupKey: 'K' });
  // Sleep 2ms to ensure clock advances even on fast systems.
  await new Promise(r => setTimeout(r, 2));
  const second = await ev.appendEvent({ topic: 't.dup', payload: { v: 2 }, dedupKey: 'K' });
  assert.equal(first.ts, second.ts, 'dedup returns the original row');
  assert.equal(second.payload.v, 1, 'payload of returned row is the original, not the new attempt');

  const all = await ev.getEventsSince('t.dup', null);
  assert.equal(all.length, 1, 'only one line on disk');
});

test('dedup: different dedupKey on same topic creates a new row', async () => {
  resetIDB();
  await ev.appendEvent({ topic: 't.dup2', payload: { v: 1 }, dedupKey: 'A' });
  await ev.appendEvent({ topic: 't.dup2', payload: { v: 2 }, dedupKey: 'B' });
  const all = await ev.getEventsSince('t.dup2', null);
  assert.equal(all.length, 2);
});

test('dedup: same dedupKey on different topics is allowed', async () => {
  resetIDB();
  await ev.appendEvent({ topic: 't.x', payload: {}, dedupKey: 'shared' });
  await ev.appendEvent({ topic: 't.y', payload: {}, dedupKey: 'shared' });
  assert.equal((await ev.getEventsSince('t.x', null)).length, 1);
  assert.equal((await ev.getEventsSince('t.y', null)).length, 1);
});

test('dedup: emit without dedupKey is never collapsed even on identical payload', async () => {
  resetIDB();
  await ev.appendEvent({ topic: 't.nodup', payload: { v: 1 } });
  await new Promise(r => setTimeout(r, 2));
  await ev.appendEvent({ topic: 't.nodup', payload: { v: 1 } });
  assert.equal((await ev.getEventsSince('t.nodup', null)).length, 2);
});

test('dedup: collision older than 24h does NOT collapse (a fresh row is appended)', async () => {
  resetIDB();
  // Hand-craft an old line directly via file-store so we can place a stale ts.
  const oldTs = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await fs.appendFile(
    'events/t.expired.jsonl',
    JSON.stringify({ ts: oldTs, payload: { v: 'old' }, dedupKey: 'STALE' }) + '\n',
  );

  const row = await ev.appendEvent({ topic: 't.expired', payload: { v: 'new' }, dedupKey: 'STALE' });
  assert.notEqual(row.ts, oldTs, 'fresh row appended, did not collapse onto stale one');

  const all = await ev.getEventsSince('t.expired', null);
  assert.equal(all.length, 2);
});

// ── Cursor semantics ───────────────────────────────────────────────────────

test('getEventsSince(topic, null) returns all events', async () => {
  resetIDB();
  await ev.appendEvent({ topic: 't.cur', payload: { n: 1 } });
  await new Promise(r => setTimeout(r, 2));
  await ev.appendEvent({ topic: 't.cur', payload: { n: 2 } });
  const all = await ev.getEventsSince('t.cur', null);
  assert.equal(all.length, 2);
});

test('getEventsSince(topic, ts) returns only events strictly after ts', async () => {
  resetIDB();
  const a = await ev.appendEvent({ topic: 't.cur2', payload: { n: 1 } });
  await new Promise(r => setTimeout(r, 2));
  const b = await ev.appendEvent({ topic: 't.cur2', payload: { n: 2 } });

  const afterA = await ev.getEventsSince('t.cur2', a.ts);
  assert.equal(afterA.length, 1);
  assert.equal(afterA[0].payload.n, 2);

  const afterB = await ev.getEventsSince('t.cur2', b.ts);
  assert.equal(afterB.length, 0, 'cursor at latest returns empty');
});

test('getEventsSince on unknown topic returns []', async () => {
  resetIDB();
  const out = await ev.getEventsSince('nope.never', null);
  assert.deepEqual(out, []);
});

test('latestEventTs and oldestEventTs', async () => {
  resetIDB();
  assert.equal(await ev.latestEventTs('t.empty'), null);
  assert.equal(await ev.oldestEventTs('t.empty'), null);

  const a = await ev.appendEvent({ topic: 't.span', payload: {} });
  await new Promise(r => setTimeout(r, 2));
  const b = await ev.appendEvent({ topic: 't.span', payload: {} });
  await new Promise(r => setTimeout(r, 2));
  const c = await ev.appendEvent({ topic: 't.span', payload: {} });

  assert.equal(await ev.oldestEventTs('t.span'), a.ts);
  assert.equal(await ev.latestEventTs('t.span'), c.ts);
  assert.ok(b.ts > a.ts && b.ts < c.ts);
});

// ── Malformed lines are tolerated ──────────────────────────────────────────

test('parser skips malformed lines without throwing', async () => {
  resetIDB();
  await fs.appendFile(
    'events/t.bad.jsonl',
    'not-json\n' +
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', payload: { ok: true } }) + '\n' +
    '{"truncated":' + '\n',
  );
  const all = await ev.getEventsSince('t.bad', null);
  assert.equal(all.length, 1);
  assert.equal(all[0].payload.ok, true);
});

// ── listTopics ─────────────────────────────────────────────────────────────

test('listTopics returns topic names, strips events/ prefix and .jsonl suffix', async () => {
  resetIDB();
  await ev.appendEvent({ topic: 'lead.found', payload: {} });
  await ev.appendEvent({ topic: 'gmail.reply.received', payload: {} });

  const topics = await ev.listTopics();
  assert.deepEqual(topics.sort(), ['gmail.reply.received', 'lead.found']);
});

test('listTopics on empty store returns []', async () => {
  resetIDB();
  assert.deepEqual(await ev.listTopics(), []);
});

// ── gcEvents ───────────────────────────────────────────────────────────────

test('gcEvents drops lines older than maxAgeDays and rewrites file', async () => {
  resetIDB();
  const oldTs   = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  const freshTs = new Date().toISOString();
  await fs.appendFile(
    'events/t.gc.jsonl',
    JSON.stringify({ ts: oldTs,   payload: { age: 'old' } })   + '\n' +
    JSON.stringify({ ts: freshTs, payload: { age: 'fresh' } }) + '\n',
  );

  const r = await ev.gcEvents(30);
  assert.equal(r.dropped, 1);
  assert.ok(r.topics >= 1);

  const remaining = await ev.getEventsSince('t.gc', null);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].payload.age, 'fresh');
});

test('gcEvents leaves files alone when nothing is old enough', async () => {
  resetIDB();
  const before = await ev.appendEvent({ topic: 't.young', payload: {} });
  const r = await ev.gcEvents(30);
  assert.equal(r.dropped, 0);

  const all = await ev.getEventsSince('t.young', null);
  assert.equal(all.length, 1);
  assert.equal(all[0].ts, before.ts);
});

test('gcEvents on empty store is a no-op', async () => {
  resetIDB();
  const r = await ev.gcEvents(30);
  assert.equal(r.dropped, 0);
  assert.equal(r.topics, 0);
});

// ── Topic names with special chars ─────────────────────────────────────────

test('topic names with dots, dashes, underscores round-trip', async () => {
  resetIDB();
  const t = 'lead.found.in-budget_v2';
  await ev.appendEvent({ topic: t, payload: { ok: true } });
  const all = await ev.getEventsSince(t, null);
  assert.equal(all.length, 1);
  const topics = await ev.listTopics();
  assert.ok(topics.includes(t));
});

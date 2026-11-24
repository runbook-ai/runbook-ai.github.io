// Relay tests against the real server. Run: cd proxy && node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://test.local';
let base, proc;

test.before(async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  proc = spawn(process.execPath, [path.join(here, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), EXTRA_ORIGINS: ORIGIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (/listening/.test(String(d))) resolve(); });
    proc.on('exit', c => reject(new Error(`server exited ${c}`)));
  });
  base = `http://127.0.0.1:${port}`;
});
test.after(() => proc.kill());

const room = () => 'r' + Math.random().toString(36).slice(2).padEnd(24, 'x');
const hdr = (extra = {}) => ({ Origin: ORIGIN, 'Content-Type': 'application/json', ...extra });

/** Open the SSE stream and return {events(), close()}; events() waits for n. */
async function listen(id) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/relay/${id}/events`, { headers: { Origin: ORIGIN }, signal: ctl.signal });
  const got = [];
  let wake = () => {};
  if (res.status === 200) {
    (async () => {
      const reader = res.body.getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (ev) { got.push({ ev, data: JSON.parse(data) }); wake(); }
          }
        }
      } catch { /* aborted */ }
    })();
  }
  return {
    status: res.status,
    headers: res.headers,
    async events(n, ms = 2000) {
      const t = Date.now();
      while (got.length < n && Date.now() - t < ms) await new Promise(r => { wake = r; setTimeout(r, 50); });
      return got.slice(0, n);
    },
    close: () => ctl.abort(),
  };
}

const photo = (o = {}) => ({ batch: 'batch-123456', index: 1, count: 2, name: 'photo-01.jpg', type: 'image/jpeg', iv: 'aXY', data: 'Y2lwaGVy', ...o });
const post = (id, kind, body, extra) => fetch(`${base}/relay/${id}/${kind}`, { method: 'POST', headers: hdr(extra), body: typeof body === 'string' ? body : JSON.stringify(body) });

test('desktop listens; phone hello and a batch of photos are forwarded in order', async () => {
  const id = room();
  const l = await listen(id);
  assert.equal(l.status, 200);
  assert.equal(l.headers.get('content-type'), 'text/event-stream');
  assert.equal(l.headers.get('x-accel-buffering'), 'no');
  assert.equal(l.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await post(id, 'hello', { device: 'Pixel' })).status, 200);
  assert.equal((await post(id, 'photo', photo())).status, 200);
  assert.equal((await post(id, 'photo', photo({ index: 2, name: 'photo-02.jpg' }))).status, 200);
  const ev = await l.events(4);
  assert.deepEqual(ev.map(e => e.ev), ['ready', 'phone', 'photo', 'photo']);
  assert.equal(ev[1].data.device, 'Pixel');
  assert.deepEqual(ev[3].data, photo({ index: 2, name: 'photo-02.jpg' }));
  l.close();
});

test('no listener -> 404; second listener -> 409; disconnect removes the room', async () => {
  const id = room();
  assert.equal((await post(id, 'photo', photo())).status, 404);
  const l = await listen(id);
  assert.equal((await listen(id)).status, 409);
  l.close();
  await new Promise(r => setTimeout(r, 200));
  const r = await post(id, 'photo', photo());
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'room-not-found');
});

test('validation: bad batch fields, bad JSON, oversize, bad route, origin', async () => {
  const id = room();
  const l = await listen(id);
  for (const bad of [{ index: 0 }, { index: 3, count: 2 }, { count: 51, index: 1 }, { batch: 'x' }, { index: 1.5 }]) {
    const r = await post(id, 'photo', photo(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await post(id, 'photo', '{not json')).status, 400);
  assert.equal((await post(id, 'photo', photo({ data: 'x'.repeat(13 * 1024 * 1024) }))).status, 413);
  assert.equal((await fetch(`${base}/relay/short/events`, { headers: { Origin: ORIGIN } })).status, 404);
  assert.equal((await fetch(`${base}/relay/${id}/photo`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  // Preflight for the phone's JSON POST.
  const pre = await fetch(`${base}/relay/${id}/photo`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(pre.status, 204);
  l.close();
});

test('per-IP POST rate limit; spoofed X-Forwarded-For does not reset it', async () => {
  const id = room();
  let last;
  for (let i = 0; i < 125; i++) {
    last = await post(id, 'hello', { device: 'x' }, { 'X-Real-IP': '203.0.113.50', 'X-Forwarded-For': `9.9.${i}.1, 203.0.113.50` });
  }
  assert.equal(last.status, 429);
  // A different real client is unaffected.
  assert.equal((await post(id, 'hello', {}, { 'X-Real-IP': '198.51.100.1' })).status, 404);
});

// Unit tests for the runbooks page's pure modules. Run: node --test runbooks/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify, validateRunbook, fillTemplate, placeholders, manifestJson, lineDiff } from '../js/runbook-format.js';
import { zipFiles, unzip, crc32 } from '../js/zip.js';
import { newKey, importKey, encryptBytes, decryptBytes, randomId, b64urlEncode, b64urlDecode } from '../js/crypto.js';
import { createStore, MAX_VERSIONS } from '../js/local-store.js';
import { exportZip, candidatesFromFiles, candidatesFromJson } from '../js/runbook-io.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRunbooks = path.join(here, '..');

function fakeStorage({ quotaAfter = Infinity } = {}) {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (v.length > quotaAfter) { const e = new Error('exceeded'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: k => m.delete(k),
  };
}

const RB = {
  slug: 'find-things',
  manifest: { title: 'Find things', params: [{ name: 'query', label: 'Query', type: 'text', default: 'x' }] },
  prompt: 'Search for {{query}}.',
};

test('slugify', () => {
  assert.equal(slugify('Pay My Medical Bill!'), 'pay-my-medical-bill');
  assert.equal(slugify('  Café — déjà vu '), 'cafe-deja-vu');
  assert.equal(slugify(''), 'my-runbook');
  assert.ok(slugify('a'.repeat(100)).length <= 64);
});

test('fillTemplate and placeholders', () => {
  assert.equal(fillTemplate('a {{x}} b {{ y }} {{z}}', { x: 1, y: 'two' }), 'a 1 b two ');
  assert.deepEqual(placeholders('{{a}} {{b}} {{a}}'), ['a', 'b']);
});

test('validateRunbook catches errors and warns on placeholder mismatches', () => {
  assert.deepEqual(validateRunbook(RB).errors, []);
  const bad = validateRunbook({ slug: 'Bad Slug', manifest: { params: [{ name: 'a b', type: 'color' }, {}] }, prompt: '' });
  assert.ok(bad.errors.some(e => /Slug/.test(e)));
  assert.ok(bad.errors.some(e => /title/.test(e)));
  assert.ok(bad.errors.some(e => /type "color"/.test(e)));
  assert.ok(bad.errors.some(e => /prompt.md is empty/.test(e)));
  const warn = validateRunbook({ ...RB, prompt: 'Find {{nope}}' });
  assert.ok(warn.warnings.some(w => /\{\{nope\}\}/.test(w)));
  assert.ok(warn.warnings.some(w => /"query" is not used/.test(w)));
});

test('the repo runbooks validate cleanly', () => {
  const list = JSON.parse(fs.readFileSync(path.join(repoRunbooks, 'runbooks.json'), 'utf8'));
  for (const { slug } of list) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRunbooks, slug, 'manifest.json'), 'utf8'));
    const prompt = fs.readFileSync(path.join(repoRunbooks, slug, 'prompt.md'), 'utf8');
    assert.deepEqual(validateRunbook({ slug, manifest, prompt }).errors, [], slug);
  }
});

test('lineDiff', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d.map(x => x.op + x.line), ['samea', 'delb', 'addB', 'samec', 'addd']);
});

test('zip round trip (store)', async () => {
  const z = zipFiles([{ path: 'a/x.txt', data: 'hello' }, { path: 'a/ü.md', data: 'ünïcode' }]);
  const out = await unzip(z);
  assert.deepEqual(out.map(e => [e.path, new TextDecoder().decode(e.data)]), [['a/x.txt', 'hello'], ['a/ü.md', 'ünïcode']]);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('unzip reads a deflate zip made by the zip CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbzip-'));
  fs.mkdirSync(path.join(dir, 'my-rb'));
  fs.writeFileSync(path.join(dir, 'my-rb', 'manifest.json'), JSON.stringify(RB.manifest));
  fs.writeFileSync(path.join(dir, 'my-rb', 'prompt.md'), RB.prompt.repeat(50));
  execFileSync('zip', ['-qr', 'out.zip', 'my-rb'], { cwd: dir });
  const out = await unzip(fs.readFileSync(path.join(dir, 'out.zip')));
  const prompt = out.find(e => e.path === 'my-rb/prompt.md');
  assert.equal(new TextDecoder().decode(prompt.data), RB.prompt.repeat(50));
});

test('crypto round trip; tampering and wrong key fail', async () => {
  const { key, raw } = await newKey();
  assert.equal(raw.length, 43);
  const k2 = await importKey(raw);
  const msg = new Uint8Array([1, 2, 3, 250]);
  const ct = await encryptBytes(key, msg);
  assert.deepEqual(await decryptBytes(k2, ct), msg);
  const bytes = b64urlDecode(ct.data); bytes[0] ^= 1;
  await assert.rejects(decryptBytes(k2, { iv: ct.iv, data: b64urlEncode(bytes) }));
  const other = await newKey();
  await assert.rejects(decryptBytes(other.key, ct));
  assert.equal(randomId().length, 22);
});

test('local store: save, versions, restore, remove', () => {
  const s = createStore(fakeStorage());
  assert.ok(s.save(RB.slug, RB).ok);
  assert.equal(s.get(RB.slug).version, 1);
  // Unchanged save doesn't bump the version.
  s.save(RB.slug, RB);
  assert.equal(s.get(RB.slug).version, 1);
  for (let i = 0; i < MAX_VERSIONS + 3; i++) s.save(RB.slug, { ...RB, prompt: `Search for {{query}} #${i}` }, `edit ${i}`);
  const cur = s.get(RB.slug);
  assert.equal(cur.version, MAX_VERSIONS + 4);
  assert.equal(cur.versions.length, MAX_VERSIONS);
  const oldest = cur.versions[0].version;
  assert.ok(s.restore(RB.slug, oldest).ok);
  assert.match(s.get(RB.slug).note, /restored/);
  assert.equal(s.uniqueSlug(RB.slug), `${RB.slug}-2`);
  assert.equal(s.list().length, 1);
  s.remove(RB.slug);
  assert.equal(s.get(RB.slug), null);
});

test('local store: rejects invalid, reports quota and missing storage', () => {
  assert.equal(createStore(fakeStorage()).save('x', { manifest: {}, prompt: '' }).error, 'invalid-runbook');
  assert.equal(createStore(fakeStorage({ quotaAfter: 10 })).save(RB.slug, RB).error, 'quota-exceeded');
  const none = createStore(null);
  assert.equal(none.save(RB.slug, RB).error, 'storage-unavailable');
  assert.deepEqual(none.list(), []);
});

test('export -> import round trip keeps the repo format', async () => {
  const rb = { ...RB, extraFiles: { 'agent-card.md': '# card' } };
  const z = exportZip([rb, { ...RB, slug: 'second' }]);
  const entries = await unzip(z);
  assert.deepEqual(entries.map(e => e.path).sort(), ['find-things/agent-card.md', 'find-things/manifest.json', 'find-things/prompt.md', 'second/manifest.json', 'second/prompt.md']);
  const manifestText = new TextDecoder().decode(entries.find(e => e.path === 'find-things/manifest.json').data);
  assert.equal(manifestText, JSON.stringify(RB.manifest.title ? { title: 'Find things', params: [{ name: 'query', label: 'Query', type: 'text', default: 'x' }] } : {}, null, 2) + '\n');
  const cands = await candidatesFromFiles([{ path: 'mine.zip', data: z }]);
  assert.equal(cands.length, 2);
  const c = cands.find(x => x.slug === 'find-things');
  assert.deepEqual(c.errors, []);
  assert.equal(c.prompt, RB.prompt + '\n');
  assert.equal(c.extraFiles['agent-card.md'], '# card');
});

test('import: loose files, binary skipped, bad manifest, pasted JSON', async () => {
  const enc = new TextEncoder();
  const loose = await candidatesFromFiles([
    { path: 'manifest.json', data: enc.encode(JSON.stringify(RB.manifest)) },
    { path: 'prompt.md', data: enc.encode(RB.prompt) },
    { path: 'demo.gif', data: new Uint8Array([71, 73, 70]) },
  ]);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].slug, 'find-things');
  assert.ok(loose[0].warnings.some(w => /demo.gif/.test(w)));
  const broken = await candidatesFromFiles([{ path: 'x/manifest.json', data: '{nope' }, { path: 'x/prompt.md', data: 'hi' }]);
  assert.ok(broken[0].errors.some(e => /not valid JSON/.test(e)));
  const pasted = candidatesFromJson(JSON.stringify([RB, { slug: 'Weird Name', manifest: { title: 'T' }, prompt: 'p' }]));
  assert.deepEqual(pasted.map(p => p.slug), ['find-things', 'weird-name']);
  assert.ok(candidatesFromJson('nope')[0].errors.length);
});

test('voiceMergeText (same rules as the side panel)', async () => {
  const { voiceMergeText } = await import('../js/voice-input.js');
  assert.equal(voiceMergeText('', ' hello '), 'hello');
  assert.equal(voiceMergeText('find', 'cars'), 'find cars');
  assert.equal(voiceMergeText('find ', 'cars'), 'find cars');
  assert.equal(voiceMergeText('find', ''), 'find');
});

test('designer: draft checks and message building', async () => {
  const { checkDraft, buildMessages, DESIGNER_SYSTEM } = await import('../js/designer-llm.js');
  const ok = checkDraft({ slug: 'Find Things', manifest: RB.manifest, prompt: RB.prompt, summary: 's', notes: ['n'], changes: [] });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.draft.slug, 'find-things');
  const bad = checkDraft({ slug: 'x', manifest: { title: 'T', params: [] }, prompt: 'Use {{missing}}' });
  assert.ok(bad.problems.some(p => /missing/.test(p)));
  const own = checkDraft({ slug: 'renamed', manifest: RB.manifest, prompt: RB.prompt }, { ownSlug: 'find-things' });
  assert.equal(own.draft.slug, 'find-things', 'revisions keep the slug');
  const msgs = buildMessages({ examples: [{ slug: 'e', manifest: { title: 'E' }, prompt: 'p' }], history: [{ role: 'user', content: 'earlier' }], current: RB, evidence: { status: 'failed' }, request: '' });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.startsWith(DESIGNER_SYSTEM));
  assert.ok(msgs[0].content.includes('### e'));
  assert.equal(msgs[1].content, 'earlier');
  assert.ok(/Current runbook/.test(msgs.at(-1).content) && /Run evidence/.test(msgs.at(-1).content) && /diagnose/.test(msgs.at(-1).content));
});

// Unit tests for the runbooks page's pure modules. Run: node --test runbooks/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify, validateRunbook, validateTrace, fillTemplate, placeholders } from '../js/runbook-format.js';
import { runConfig } from '../js/run.js';
import { newKey, importKey, encryptBytes, decryptBytes, randomId, b64urlEncode, b64urlDecode } from '../js/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRunbooks = path.join(here, '..');

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


test('manifest.config and trace.json validation', () => {
  assert.deepEqual(validateRunbook({ ...RB, manifest: { ...RB.manifest, config: { maxSteps: 14 } } }).errors, []);
  assert.ok(validateRunbook({ ...RB, manifest: { ...RB.manifest, config: { model: 'x' } } }).errors.some(e => /not supported/.test(e)));
  const trace = { version: 1, steps: [{ tool: 'browse', label: 'Search {{query}}', ok: true, actions: [] }] };
  assert.deepEqual(validateTrace(trace, RB.manifest).errors, []);
  assert.ok(validateTrace({ ...trace, steps: [{ tool: 'done', label: '{{nope}}' }] }, RB.manifest).errors.some(e => /nope/.test(e)));
  assert.ok(validateTrace({ version: 2, steps: [] }, RB.manifest).errors.length);
});

test('repo trace.json files validate', () => {
  const list = JSON.parse(fs.readFileSync(path.join(repoRunbooks, 'runbooks.json'), 'utf8'));
  for (const { slug } of list) {
    const p = path.join(repoRunbooks, slug, 'trace.json');
    if (!fs.existsSync(p)) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRunbooks, slug, 'manifest.json'), 'utf8'));
    assert.deepEqual(validateTrace(JSON.parse(fs.readFileSync(p, 'utf8')), manifest).errors, [], slug);
  }
});

test('runConfig clamps manifest limits', () => {
  assert.deepEqual(runConfig(null), { maxSteps: 30 });
  assert.deepEqual(runConfig({ maxSteps: 14, maxIterations: 40 }), { maxSteps: 14, maxIterations: 40 });
  assert.deepEqual(runConfig({ maxSteps: 500, maxIterations: 1 }), { maxSteps: 60, maxIterations: 5 });
});

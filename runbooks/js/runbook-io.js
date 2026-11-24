// Import / export of runbooks in the repo folder format:
//   <slug>/manifest.json, <slug>/prompt.md, plus optional text files.
// Pure (no DOM); the page turns File objects into {path, data} first.

import { zipFiles, unzip } from './zip.js';
import { slugify, validateRunbook, manifestJson, SLUG_RE } from './runbook-format.js';

const TEXT_EXT = /\.(md|txt|json|csv|ya?ml)$/i;
const dec = new TextDecoder();

/** Files of one runbook, as zip entries under `<slug>/`. */
export function runbookEntries(rb) {
  const entries = [
    { path: `${rb.slug}/manifest.json`, data: manifestJson(rb.manifest) },
    { path: `${rb.slug}/prompt.md`, data: rb.prompt.endsWith('\n') ? rb.prompt : rb.prompt + '\n' },
  ];
  for (const [name, text] of Object.entries(rb.extraFiles || {})) {
    if (name === 'manifest.json' || name === 'prompt.md') continue;
    entries.push({ path: `${rb.slug}/${name}`, data: text });
  }
  return entries;
}

export function exportZip(runbooks) {
  return zipFiles(runbooks.flatMap(runbookEntries));
}

/**
 * Turn a flat list of files into runbook candidates.
 * files: [{path, data: Uint8Array|string}] -- `path` may include folders.
 * A .zip entry is expanded; a .json that isn't a manifest is tried as a
 * pasted bundle ({slug, manifest, prompt} or an array of them).
 * Returns [{slug, manifest, prompt, extraFiles, errors, warnings, skipped}].
 */
export async function candidatesFromFiles(files) {
  const flat = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.path)) {
      const inner = await unzip(f.data);
      for (const e of inner) flat.push({ path: e.path, data: e.data });
    } else {
      flat.push(f);
    }
  }
  // Ignore OS junk.
  const clean = flat.filter(f => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(f.path));
  const text = f => (typeof f.data === 'string' ? f.data : dec.decode(f.data));

  const out = [];
  const manifests = clean.filter(f => /(^|\/)manifest\.json$/i.test(f.path));
  const usedDirs = new Set();
  for (const m of manifests) {
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
    usedDirs.add(dir);
    const inDir = clean.filter(f => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === dir);
    const promptFile = inDir.find(f => /(^|\/)prompt\.md$/i.test(f.path));
    let manifest = null;
    const errors = [];
    try { manifest = JSON.parse(text(m)); } catch (e) { errors.push(`manifest.json is not valid JSON: ${e.message}`); }
    const folder = dir.split('/').pop() || '';
    const slug = SLUG_RE.test(folder) ? folder : slugify(folder || manifest?.title || 'runbook');
    const extraFiles = {};
    const skipped = [];
    for (const f of inDir) {
      const name = f.path.split('/').pop();
      if (/^(manifest\.json|prompt\.md)$/i.test(name)) continue;
      if (TEXT_EXT.test(name)) extraFiles[name] = text(f);
      else skipped.push(name);
    }
    out.push(finish({ slug, manifest, prompt: promptFile ? text(promptFile) : '', extraFiles, skipped, errors }));
  }

  // Loose JSON bundles (pasted / saved bundles), not inside a manifest folder.
  for (const f of clean) {
    if (!/\.json$/i.test(f.path) || /(^|\/)manifest\.json$/i.test(f.path)) continue;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (usedDirs.has(dir) && manifests.length) continue;
    out.push(...candidatesFromJson(text(f)));
  }
  return out;
}

/** Pasted JSON: {slug?, manifest, prompt} or an array of them. */
export function candidatesFromJson(str) {
  let val;
  try { val = JSON.parse(str); } catch (e) {
    return [finish({ slug: '', manifest: null, prompt: '', errors: [`Not valid JSON: ${e.message}`] })];
  }
  const items = Array.isArray(val) ? val : [val];
  return items.map(it => {
    if (!it || typeof it !== 'object' || !it.manifest) {
      return finish({ slug: '', manifest: null, prompt: '', errors: ['Expected {"slug", "manifest", "prompt"}.'] });
    }
    const slug = SLUG_RE.test(String(it.slug || '')) ? it.slug : slugify(it.slug || it.manifest.title);
    return finish({ slug, manifest: it.manifest, prompt: String(it.prompt || ''), extraFiles: it.extraFiles || {} });
  });
}

function finish(c) {
  const errors = [...(c.errors || [])];
  let warnings = [];
  if (c.manifest) {
    const v = validateRunbook(c);
    errors.push(...v.errors);
    warnings = v.warnings;
  } else if (!errors.length) {
    errors.push('Missing manifest.json.');
  }
  if (c.manifest && !c.prompt) { /* validateRunbook already reports an empty prompt */ }
  if (c.skipped?.length) warnings.push(`Skipped non-text files: ${c.skipped.join(', ')}.`);
  return { slug: c.slug, manifest: c.manifest, prompt: c.prompt, extraFiles: c.extraFiles || {}, errors, warnings };
}

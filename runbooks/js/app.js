// Runbooks page: router, Gallery, Run view, Import/Export/Share dialogs.
// The Designer lives in designer.js.

import { h, clear, timeAgo, download, copyText, modal, toast } from './dom.js';
import { createStore, prefs, session } from './local-store.js';
import { validateRunbook, manifestJson, slugify } from './runbook-format.js';
import { exportZip, candidatesFromFiles, candidatesFromJson } from './runbook-io.js';
import { paramsForm } from './form.js';
import { runPrompt, buildPrompt, renderResult, resultMeta, collectEvidence } from './run.js';
import { probeExtension, INSTALL_URL, extensionErrorText } from './extension.js';
import { attachVoiceInput } from './voice-input.js';

export const store = createStore();
const main = document.getElementById('main');
export let extensionInstalled = null;   // resolved by probe at startup

// ----------------------------------------------------------- repo data ---

async function loadRepoList() {
  const list = await fetch('runbooks.json').then(r => r.json());
  const out = [];
  for (const { slug } of list) {
    try { out.push({ slug, manifest: await loadRepoManifest(slug) }); } catch (e) { console.error(e); }
  }
  return out;
}
const loadRepoManifest = slug => fetch(`${slug}/manifest.json`).then(r => { if (!r.ok) throw new Error(`manifest for ${slug} not found`); return r.json(); });
const loadRepoPrompt = slug => fetch(`${slug}/prompt.md`).then(r => { if (!r.ok) throw new Error(`prompt for ${slug} not found`); return r.text(); });

export async function loadRepoRunbook(slug) {
  const [manifest, prompt] = await Promise.all([loadRepoManifest(slug), loadRepoPrompt(slug)]);
  return { slug, manifest, prompt };
}

// ------------------------------------------------------------- helpers ---

export function storageBanner() {
  return store.isAvailable() ? null : h('div.banner.banner-warn', "This browser isn't letting the page save. Export to keep your runbooks.");
}

export function extensionBanner() {
  if (extensionInstalled !== false) return null;
  return h('div.banner', 'Running a runbook needs the Runbook AI Chrome extension. ',
    h('a', { href: INSTALL_URL, target: '_blank', rel: 'noopener' }, 'Install it'), ', then reload this page.');
}

const ORIGIN_LABEL = { designer: 'Designed', import: 'Imported', copy: 'Copied' };

export function copyToMine(rb) {
  const slug = store.uniqueSlug(rb.slug);
  const r = store.save(slug, { manifest: rb.manifest, prompt: rb.prompt, origin: { kind: 'copy', from: rb.slug } }, `copied from ${rb.slug}`);
  if (r.error) { toast(r.message, 'error'); return null; }
  return slug;
}

export function exportRunbooks(list, name) {
  download(name, exportZip(list), 'application/zip');
}

export function navigate(query) {
  history.pushState(null, '', query || location.pathname);
  route();
}

// Intercept same-page links so navigation keeps state without reloads.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', () => route());

// ------------------------------------------------------------- gallery ---

async function renderGallery() {
  document.title = 'Runbooks — Runbook AI';
  const mine = store.list();
  let tab = prefs.get('galleryTab', null) || (mine.length ? 'mine' : 'community');
  if (tab === 'mine' && !mine.length && prefs.get('galleryTab', null) === null) tab = 'community';

  const tabs = h('div.tabs', { role: 'tablist' });
  const body = h('div');
  const mkTab = (id, label) => h('button.tab', {
    role: 'tab', 'aria-selected': String(tab === id),
    onclick: () => { tab = id; prefs.set('galleryTab', id); draw(); },
  }, label);

  const intro = h('div.page-intro',
    h('div.intro-row',
      h('div', h('h1', 'Runbooks'), h('p', 'Ready-to-run automations for the Runbook AI extension — or describe your own.')),
      h('div.intro-actions',
        h('button.btn.btn-ghost', { onclick: openImport }, 'Import'),
        h('a.btn', { href: '?design', 'data-nav': '' }, '+ New runbook'))),
  );

  async function draw() {
    clear(tabs).append(mkTab('community', 'Community'), mkTab('mine', `My runbooks${mine.length ? ` (${mine.length})` : ''}`));
    clear(body);
    if (tab === 'mine') drawMine(body, store.list());
    else await drawCommunity(body);
  }

  clear(main).append(intro, storageBanner() || '', tabs, body);
  await draw();
}

async function drawCommunity(body) {
  const grid = h('div.gallery');
  body.append(grid, h('div.pr-row',
    h('a.pr-banner', { href: 'https://github.com/runbook-ai/runbook-ai.github.io', target: '_blank', rel: 'noopener' }, 'Share your runbook — send a PR')));
  for (const { slug, manifest } of await loadRepoList()) {
    const thumb = h('div.card-thumb', { style: { backgroundImage: `url('${slug}/demo.gif')` } });
    const probe = new Image();
    probe.onerror = () => { thumb.style.backgroundImage = ''; thumb.textContent = 'No preview'; };
    probe.src = `${slug}/demo.gif`;
    grid.append(h('a.runbook-card', { href: `?runbook=${encodeURIComponent(slug)}`, 'data-nav': '' },
      thumb,
      h('div.card-body', h('div.card-title', manifest.title || slug), h('div.card-desc', manifest.description || ''))));
  }
}

function drawMine(body, list) {
  if (!list.length) {
    body.append(designerStarter());
    return;
  }
  const grid = h('div.gallery.gallery-mine');
  for (const rb of list) {
    const menu = h('div.card-menu',
      h('a', { href: `?local=${encodeURIComponent(rb.slug)}`, 'data-nav': '' }, 'Run'),
      h('a', { href: `?design=${encodeURIComponent(rb.slug)}`, 'data-nav': '' }, 'Edit in designer'),
      h('button', { onclick: () => exportRunbooks([rb], `${rb.slug}.zip`) }, 'Export'),
      h('button.danger', {
        onclick: () => {
          if (!confirm(`Delete "${rb.manifest.title}"? This can't be undone (export it first to keep a copy).`)) return;
          store.remove(rb.slug);
          renderGallery();
        },
      }, 'Delete'));
    grid.append(h('div.runbook-card.local-card',
      h('a.card-body', { href: `?local=${encodeURIComponent(rb.slug)}`, 'data-nav': '' },
        h('div.card-title', rb.manifest.title || rb.slug),
        h('div.card-desc', rb.manifest.description || ''),
      ),
      h('div.card-foot',
        h('span.badge', ORIGIN_LABEL[rb.origin?.kind] || 'Local'), h('span.fine', `v${rb.version || 1} · ${timeAgo(rb.updatedAt)}`),
        h('details.card-more', h('summary', { 'aria-label': 'More actions' }, '⋯'), menu))));
  }
  body.append(designerStarter(true), grid,
    h('div.row.end', h('button.btn.btn-ghost', { onclick: () => exportRunbooks(store.list(), 'my-runbooks.zip') }, 'Export all')));
}

/** The designer's prompt box, inline on the gallery. */
function designerStarter(compact = false) {
  const box = h('textarea.starter-input', { rows: compact ? 2 : 3, placeholder: 'Describe a task, e.g. “Every Monday, check my utility accounts and email me a table of what I owe.”' });
  const mic = h('button.icon-btn');
  const go = () => {
    const text = box.value.trim();
    if (!text) { box.focus(); return; }
    voice.cancel();
    session.set('runbookai.designer.seed', { request: text });
    navigate('?design');
  };
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  const voice = attachVoiceInput(box, mic, { onError: msg => toast(msg, 'error') });
  return h('div.starter' + (compact ? '.starter-compact' : ''),
    compact ? null : h('h3', 'Describe a task and we’ll write the runbook for you'),
    h('div.input-with-actions', box, h('div.input-actions', mic, h('button.btn', { onclick: go }, 'Design →'))));
}

// ---------------------------------------------------------------- run ---

async function renderRun({ slug, local }) {
  let rb;
  try {
    rb = local ? store.get(slug) : await loadRepoRunbook(slug);
    if (!rb) throw new Error('not found');
  } catch {
    clear(main).append(h('a.detail-back', { href: './', 'data-nav': '' }, '← All runbooks'),
      h('div.detail-card', h('h1.detail-title', 'Runbook not found'), h('p.detail-desc', `Could not load "${slug}".`)));
    return;
  }
  const manifest = rb.manifest;
  document.title = `${manifest.title} — Runbook AI`;

  // Left column.
  const left = h('div.detail-card',
    h('h1.detail-title', manifest.title || slug),
    h('p.detail-desc', manifest.description || ''),
    manifest.note ? h('div.runbook-note', manifest.note) : null);
  if (!local) {
    const img = h('img.detail-gif', { src: `${slug}/demo.gif`, alt: `${manifest.title} demo` });
    img.onerror = () => img.replaceWith(h('div.gif-placeholder', 'Demo coming soon'));
    left.append(img, h('div.action-bar',
      h('span.badge', 'Community'),
      h('button.btn.btn-ghost', { onclick: () => { const s = copyToMine(rb); if (s) { toast('Copied to My runbooks.'); navigate(`?local=${encodeURIComponent(s)}`); } } }, 'Copy to my runbooks')));
  } else {
    left.append(h('div.action-bar',
      h('span.badge', ORIGIN_LABEL[rb.origin?.kind] || 'Local'),
      h('span.fine', `v${rb.version || 1} · edited ${timeAgo(rb.updatedAt)}`),
      h('a.btn.btn-ghost', { href: `?design=${encodeURIComponent(slug)}`, 'data-nav': '' }, 'Edit in designer'),
      h('button.btn.btn-ghost', { onclick: () => exportRunbooks([rb], `${slug}.zip`) }, 'Export'),
      h('button.btn.btn-ghost', { onclick: () => openShare(rb) }, 'Share via PR'),
      h('details.card-more', h('summary', { 'aria-label': 'More actions' }, '⋯'), h('div.card-menu',
        h('a', { href: `?design=${encodeURIComponent(slug)}`, 'data-nav': '' }, 'Version history'),
        h('button.danger', { onclick: () => { if (confirm(`Delete "${manifest.title}"?`)) { store.remove(slug); navigate(''); } } }, 'Delete')))));
  }

  // Right column: form + run.
  const status = h('span#status');
  const runBtn = h('button.btn.btn-run', { type: 'button' }, '▶ Run');
  const promptArea = h('textarea.prompt-area', { spellcheck: false });
  let promptDirty = false;
  promptArea.addEventListener('input', () => { promptDirty = true; });
  const form = paramsForm(manifest, { onChange: () => { if (!promptDirty) promptArea.value = buildPrompt(rb.prompt, form); gate(); } });

  // Imported runbooks: read the prompt before the first run.
  const needsReview = local && rb.origin?.kind === 'import' && !rb.reviewed;
  const reviewBox = h('input', { type: 'checkbox', id: 'reviewed' });
  const review = needsReview ? h('div.review-gate',
    h('p', h('b', 'Imported runbook. '), 'It will drive the agent in your logged-in browser, so read its prompt before the first run.'),
    h('label', reviewBox, ' I’ve read this prompt')) : null;
  reviewBox.addEventListener('change', () => {
    if (reviewBox.checked) store.update(slug, { reviewed: true });
    gate();
  });

  const disclosure = h('details.prompt-disclosure', { open: needsReview }, h('summary', 'View / edit raw prompt'), promptArea);
  function gate() {
    const missing = form.missing();
    const blocked = extensionInstalled === false || (needsReview && !reviewBox.checked);
    runBtn.disabled = missing.length > 0 || blocked;
    runBtn.title = missing.length ? `Fill in: ${missing.map(p => p.label || p.name).join(', ')}` : blocked ? (extensionInstalled === false ? 'Install the extension first' : 'Read the prompt first') : '';
  }
  promptArea.value = buildPrompt(rb.prompt, form);
  gate();

  const right = h('div.detail-card', extensionBanner() || '', review || '', form.el, h('div.run-row', runBtn, status), disclosure);

  // Result.
  const resultFrame = h('iframe.result-frame', { sandbox: 'allow-popups allow-same-origin', title: 'Runbook result' });
  const meta = h('span.result-meta');
  const feedback = h('textarea', { rows: 2, placeholder: 'What should change? e.g. “It skipped the price filter” (optional)' });
  const improve = h('div.improve',
    h('div.improve-title', 'Not quite right?'),
    h('div.input-with-actions', feedback, h('div.input-actions', h('button.btn', {
      onclick: () => {
        const target = local ? slug : copyToMine(rb);
        if (!target) return;
        const last = session.get(`runbookai.lastRun.${local ? 'local' : 'repo'}.${slug}`);
        session.set('runbookai.designer.seed', { slug: target, evidence: last?.evidence || null, request: feedback.value.trim(), fromRun: true });
        navigate(`?design=${encodeURIComponent(target)}`);
      },
    }, 'Improve in designer'))));
  const resultCard = h('div.detail-card.result-card.hidden',
    h('div.result-head', h('h2.result-title', 'Result'), meta), resultFrame, improve);

  runBtn.onclick = async () => {
    const prompt = promptArea.value.trim();
    if (!prompt) { status.textContent = 'Prompt is empty.'; status.className = 'error'; return; }
    runBtn.disabled = true;
    resultCard.classList.add('hidden');
    status.textContent = 'Starting runbook…';
    status.className = '';
    let resp = null, error = null;
    try {
      resp = await runPrompt({ prompt, files: form.allFiles(), onTick: s => { status.textContent = `Running… ${s}s (live progress in the side panel)`; } });
      const ok = resp.status === 'completed';
      status.textContent = ok ? `Completed in ${resp.elapsed}s.` : `Finished with status: ${resp.status || 'unknown'} (${resp.elapsed}s)`;
      status.className = ok ? 'success' : 'error';
      renderResult(resultFrame, resp);
      meta.textContent = resultMeta(resp);
      resultCard.classList.remove('hidden');
    } catch (err) {
      error = err.message;
      status.textContent = extensionErrorText(err);
      status.className = 'error';
    } finally {
      gate();
    }
    const evidence = await collectEvidence(resp, { values: form.values(), error });
    session.set(`runbookai.lastRun.${local ? 'local' : 'repo'}.${slug}`, { evidence, at: new Date().toISOString() });
  };

  clear(main).append(
    h('a.detail-back', { href: './', 'data-nav': '' }, '← All runbooks'),
    h('div.detail-grid', left, right),
    resultCard);
}

// ---------------------------------------------------------- dialogs ---

function openShare(rb) {
  const m = modal('Share via pull request', { wide: true });
  const manifestText = manifestJson(rb.manifest);
  m.body.append(
    h('p', 'Local runbooks use the same format as the community repo, so sharing one is a normal GitHub pull request:'),
    h('ol.steps',
      h('li', 'Fork ', h('a', { href: 'https://github.com/runbook-ai/runbook-ai.github.io', target: '_blank', rel: 'noopener' }, 'runbook-ai/runbook-ai.github.io'), '.'),
      h('li', h('button.btn.btn-ghost.btn-sm', { onclick: () => exportRunbooks([rb], `${rb.slug}.zip`) }, `Download ${rb.slug}.zip`), ' and unzip it into ', h('code', 'runbooks/'), '.'),
      h('li', 'Add ', h('code', `{ "slug": "${rb.slug}" }`), ' to ', h('code', 'runbooks/runbooks.json'), '.'),
      h('li', 'Optional: add a ', h('code', 'demo.gif'), ' to the folder.'),
      h('li', 'Open the pull request.')),
    h('p.fine', 'Using GitHub’s web editor instead? Copy the two files:'),
    h('div.row',
      h('button.btn.btn-ghost', { onclick: async () => toast((await copyText(manifestText)) ? 'manifest.json copied' : 'Copy failed') }, 'Copy manifest.json'),
      h('button.btn.btn-ghost', { onclick: async () => toast((await copyText(rb.prompt)) ? 'prompt.md copied' : 'Copy failed') }, 'Copy prompt.md')));
}

function openImport() {
  const m = modal('Import runbooks', { wide: true });
  const list = h('div.import-list');
  const fileInput = h('input', { type: 'file', multiple: true, accept: '.zip,.json,.md,.txt' });
  const dirInput = h('input', { type: 'file', webkitdirectory: true, multiple: true });
  const paste = h('textarea', { rows: 4, placeholder: 'Or paste JSON: {"slug": "...", "manifest": {...}, "prompt": "..."}' });
  const importBtn = h('button.btn', { disabled: true }, 'Import selected');
  let cands = [];

  async function fromFiles(files) {
    const entries = await Promise.all([...files].map(async f => ({ path: f.webkitRelativePath || f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    try { show(await candidatesFromFiles(entries)); } catch (err) { show([{ slug: '', errors: [err.message], warnings: [] }]); }
  }
  fileInput.addEventListener('change', () => fromFiles(fileInput.files));
  dirInput.addEventListener('change', () => fromFiles(dirInput.files));
  paste.addEventListener('input', () => { if (paste.value.trim()) show(candidatesFromJson(paste.value)); });
  const drop = h('div.dropzone.import-drop',
    h('p', 'Drop a ', h('b', '.zip'), ', a runbook folder, or ', h('code', 'manifest.json'), ' + ', h('code', 'prompt.md'), ' here'),
    h('div.row', h('label.btn.btn-ghost', 'Choose files', fileInput), h('label.btn.btn-ghost', 'Choose a folder', dirInput)));
  fileInput.hidden = dirInput.hidden = true;
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('drag');
    const files = await filesFromDrop(e.dataTransfer);
    fromFiles(files);
  });

  function show(next) {
    cands = next.map(c => ({ ...c, pick: !c.errors.length, mode: store.has(c.slug) ? 'keep' : 'new' }));
    clear(list);
    if (!cands.length) list.append(h('p.muted', 'No runbooks found. A runbook folder needs manifest.json and prompt.md.'));
    for (const c of cands) {
      const ok = !c.errors.length;
      const pick = h('input', { type: 'checkbox', checked: c.pick, disabled: !ok, onchange: e => { c.pick = e.target.checked; sync(); } });
      const conflict = ok && store.has(c.slug) ? h('select', { onchange: e => { c.mode = e.target.value; } },
        h('option', { value: 'keep' }, 'Keep both'), h('option', { value: 'replace' }, 'Replace mine')) : null;
      list.append(h('div.import-item' + (ok ? '' : '.bad'),
        h('label', pick, ' ', h('b', c.manifest?.title || c.slug || '(unknown)'), ' ', h('code', c.slug || '')),
        conflict ? h('span.fine', 'A local runbook with this slug exists: ', conflict) : null,
        ...c.errors.map(e => h('div.err', '✕ ' + e)),
        ...c.warnings.map(w => h('div.warn', '⚠ ' + w))));
    }
    sync();
  }
  const sync = () => { importBtn.disabled = !cands.some(c => c.pick); };

  importBtn.onclick = () => {
    let n = 0;
    for (const c of cands.filter(c => c.pick)) {
      const slug = c.mode === 'replace' ? c.slug : store.uniqueSlug(c.slug);
      const r = store.save(slug, { manifest: c.manifest, prompt: c.prompt, extraFiles: c.extraFiles, origin: { kind: 'import' }, reviewed: false }, 'imported');
      if (r.error) { toast(`${c.slug}: ${r.message}`, 'error'); continue; }
      n++;
    }
    if (n) {
      m.close();
      prefs.set('galleryTab', 'mine');
      toast(`Imported ${n} runbook${n === 1 ? '' : 's'}.`);
      route();
    }
  };

  m.body.append(drop, paste, list, h('div.row.end', importBtn));
}

// Folder drops: walk directory entries so paths keep their folder names.
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return [...dt.files];
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push(new File([file], file.name, { type: file.type }));
      Object.defineProperty(out[out.length - 1], 'webkitRelativePath', { value: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of items) await walk(e, '');
  return out;
}

// -------------------------------------------------------------- router ---

export async function route() {
  const q = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
  window.onbeforeunload = null;   // the designer sets its own while open
  if (q.has('design')) {
    const { renderDesigner } = await import('./designer.js');
    return renderDesigner(main, q.get('design') || null);
  }
  if (q.get('local')) return renderRun({ slug: q.get('local'), local: true });
  if (q.get('runbook')) return renderRun({ slug: q.get('runbook'), local: false });
  return renderGallery();
}

(async () => {
  extensionInstalled = await probeExtension();
  route();
})();

// Exported for designer.js.
export { slugify, validateRunbook };

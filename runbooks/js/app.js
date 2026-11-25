// Runbooks page: router, Gallery, Run view.

import { h, clear } from './dom.js';
import { paramsForm } from './form.js';
import { runPrompt, buildPrompt, renderResult, resultMeta } from './run.js';
import { probeExtension, INSTALL_URL, extensionErrorText } from './extension.js';

const main = document.getElementById('main');
let extensionInstalled = null;   // resolved by probe at startup

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

async function loadRepoRunbook(slug) {
  const [manifest, prompt] = await Promise.all([loadRepoManifest(slug), loadRepoPrompt(slug)]);
  return { slug, manifest, prompt };
}

// ------------------------------------------------------------- helpers ---

function extensionBanner() {
  if (extensionInstalled !== false) return null;
  return h('div.banner', 'Running a runbook needs the Runbook AI Chrome extension. ',
    h('a', { href: INSTALL_URL, target: '_blank', rel: 'noopener' }, 'Install it'), ', then reload this page.');
}

function navigate(query) {
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
  const grid = h('div.gallery');
  clear(main).append(
    h('div.page-intro', h('h1', 'Runbooks'), h('p', 'Ready-to-run automations for the Runbook AI extension.')),
    grid,
    h('div.pr-row',
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

// ---------------------------------------------------------------- run ---

async function renderRun(slug) {
  let rb;
  try {
    rb = await loadRepoRunbook(slug);
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
  const img = h('img.detail-gif', { src: `${slug}/demo.gif`, alt: `${manifest.title} demo` });
  img.onerror = () => img.replaceWith(h('div.gif-placeholder', 'Demo coming soon'));
  left.append(img);

  // Right column: form + run.
  const status = h('span#status');
  const runBtn = h('button.btn.btn-run', { type: 'button' }, '▶ Run');
  const promptArea = h('textarea.prompt-area', { spellcheck: false });
  let promptDirty = false;
  promptArea.addEventListener('input', () => { promptDirty = true; });
  const form = paramsForm(manifest, { onChange: () => { if (!promptDirty) promptArea.value = buildPrompt(rb.prompt, form); gate(); } });

  const disclosure = h('details.prompt-disclosure', h('summary', 'View / edit raw prompt'), promptArea);
  function gate() {
    const missing = form.missing();
    const blocked = extensionInstalled === false;
    runBtn.disabled = missing.length > 0 || blocked;
    runBtn.title = missing.length ? `Fill in: ${missing.map(p => p.label || p.name).join(', ')}` : blocked ? 'Install the extension first' : '';
  }
  promptArea.value = buildPrompt(rb.prompt, form);
  gate();

  const right = h('div.detail-card', extensionBanner() || '', form.el, h('div.run-row', runBtn, status), disclosure);

  // Result.
  const resultFrame = h('iframe.result-frame', { sandbox: 'allow-popups allow-same-origin', title: 'Runbook result' });
  const meta = h('span.result-meta');
  const resultCard = h('div.detail-card.result-card.hidden',
    h('div.result-head', h('h2.result-title', 'Result'), meta), resultFrame);

  runBtn.onclick = async () => {
    const prompt = promptArea.value.trim();
    if (!prompt) { status.textContent = 'Prompt is empty.'; status.className = 'error'; return; }
    runBtn.disabled = true;
    resultCard.classList.add('hidden');
    status.textContent = 'Starting runbook…';
    status.className = '';
    try {
      const resp = await runPrompt({ prompt, files: form.allFiles(), onTick: s => { status.textContent = `Running… ${s}s (live progress in the side panel)`; } });
      const ok = resp.status === 'completed';
      status.textContent = ok ? `Completed in ${resp.elapsed}s.` : `Finished with status: ${resp.status || 'unknown'} (${resp.elapsed}s)`;
      status.className = ok ? 'success' : 'error';
      renderResult(resultFrame, resp);
      meta.textContent = resultMeta(resp);
      resultCard.classList.remove('hidden');
    } catch (err) {
      status.textContent = extensionErrorText(err);
      status.className = 'error';
    } finally {
      gate();
    }
  };

  clear(main).append(
    h('a.detail-back', { href: './', 'data-nav': '' }, '← All runbooks'),
    h('div.detail-grid', left, right),
    resultCard);
}

// -------------------------------------------------------------- router ---

async function route() {
  const q = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
  if (q.get('runbook')) return renderRun(q.get('runbook'));
  return renderGallery();
}

(async () => {
  extensionInstalled = await probeExtension();
  route();
})();


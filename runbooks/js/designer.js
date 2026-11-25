// Runbook designer: conversation (left) + draft (right).
// Designer edits to an existing draft are always proposed as a diff
// (Changes tab, Accept / Discard); the user's own edits apply directly.

import { h, clear, timeAgo, toast } from './dom.js';
import { session } from './local-store.js';
import { validateRunbook, manifestJson, normalizeManifest, lineDiff } from './runbook-format.js';
import { paramsForm } from './form.js';
import { runPrompt, buildPrompt, renderResult, resultMeta, collectEvidence } from './run.js';
import { designTurn } from './designer-llm.js';
import { attachVoiceInput } from './voice-input.js';
import { extensionErrorText } from './extension.js';
import { store, navigate, exportRunbooks, loadRepoRunbook, extensionInstalled, storageBanner } from './app.js';

const SEED_KEY = 'runbookai.designer.seed';
const convKey = slug => `runbookai.designer.conv.${slug || 'new'}`;

export async function renderDesigner(main, slugParam) {
  let saved = slugParam ? store.get(slugParam) : null;
  if (slugParam && !saved) {
    clear(main).append(h('a.detail-back', { href: './', 'data-nav': '' }, '← All runbooks'),
      h('div.detail-card', h('h1.detail-title', 'Runbook not found'), h('p.detail-desc', `No local runbook "${slugParam}". It may have been deleted, or saved in another browser.`)));
    return;
  }
  document.title = `${saved ? saved.manifest.title + ' — ' : ''}Designer — Runbook AI`;

  // ------------------------------------------------------------ state ---
  let draft = saved ? { slug: saved.slug, manifest: saved.manifest, prompt: saved.prompt } : null;
  let pending = null;           // proposed revision {slug, manifest, prompt}
  let pendingChanges = [];
  let conv = session.get(convKey(saved?.slug), []);
  let evidence = null;          // latest unconsumed run evidence
  let busy = false;
  let tab = draft ? 'try' : 'try';
  let startFrom = null;         // {slug, manifest, prompt} to adapt (new drafts)
  const noExtension = extensionInstalled === false;

  const isDirty = () => !!draft && (!saved || JSON.stringify(normalizeManifest(draft.manifest)) !== JSON.stringify(saved.manifest) || draft.prompt !== saved.prompt);
  const persistConv = () => session.set(convKey(saved?.slug), conv.slice(-40));

  // ------------------------------------------------------------- left ---
  const thread = h('div.thread', { 'aria-live': 'polite' });
  const input = h('textarea.chat-input', { rows: 3 });
  const mic = h('button.icon-btn');
  const sendBtn = h('button.btn', { onclick: () => send() }, 'Send');
  const voice = attachVoiceInput(input, mic, { onError: msg => toast(msg, 'error') });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  const left = h('section.pane.pane-chat',
    h('div.pane-head', h('a.detail-back', { href: './', 'data-nav': '' }, '← All runbooks'), h('h2', 'Designer')),
    thread,
    h('div.composer',
      h('div.input-with-actions', input, h('div.input-actions', mic, sendBtn)),
      h('p.fine.composer-note', noExtension
        ? 'The extension isn’t installed, so the designer uses the free Runbook AI model. Install it to test-run.'
        : 'Uses the model set in the Runbook AI extension (the free Runbook AI model if no API key is set).')));

  // ------------------------------------------------------------ right ---
  const right = h('section.pane.pane-draft');

  // ---------------------------------------------------- conversation ---
  function placeholder() {
    input.placeholder = !draft
      ? 'What should this runbook do? e.g. “Find 5 used Tacomas under $25k near Denver and email me a table.”'
      : evidence
        ? 'What should change? Leave empty and press Send to let the designer diagnose the run.'
        : 'Ask for a change, e.g. “make the region a dropdown”';
  }

  function drawThread() {
    clear(thread);
    if (!conv.length) {
      thread.append(h('div.msg.msg-designer', h('div.msg-text',
        draft ? 'Ask for a change, or test-run it from the Try it tab — I’ll use the result to improve it.'
          : 'Describe the task you want automated. I’ll write the runbook — a form plus a prompt for the agent — and you can test-run and refine it here.')));
    }
    conv.forEach((m, i) => thread.append(drawMsg(m, i)));
    if (busy) thread.append(h('div.msg.msg-designer.thinking', h('div.msg-text', 'Designing…')));
    thread.scrollTop = thread.scrollHeight;
  }

  function drawMsg(m, i) {
    if (m.role === 'user') return h('div.msg.msg-user', h('div.msg-text', m.text));
    if (m.role === 'run') {
      return h('div.msg.msg-run.' + (m.status === 'completed' ? 'ok' : 'bad'),
        h('div.run-card-head', `Run · ${m.status}${m.steps != null ? ` · ${m.steps} step${m.steps === 1 ? '' : 's'}` : ''}${m.elapsed != null ? ` · ${m.elapsed}s` : ''}`),
        m.resultHead ? h('div.fine', m.resultHead) : null,
        m.evidence ? h('details', h('summary', m.used ? 'Evidence sent to the designer' : 'Evidence the designer will get'), h('pre.evidence', JSON.stringify(m.evidence, null, 2))) : null);
    }
    if (m.role === 'error') return h('div.msg.msg-error', h('div.msg-text', m.text));
    // designer
    const el = h('div.msg.msg-designer', h('div.msg-text', m.summary || (m.kind === 'proposal' ? 'Here are my proposed changes.' : 'Done.')));
    if (m.changes?.length) el.append(h('ul.changes', m.changes.map(c => h('li', c))));
    if (m.notes?.length) {
      el.append(h('div.notes-title', 'Assumptions & questions'));
      for (const [j, n] of m.notes.entries()) {
        const state = m.noteState?.[j];
        el.append(h('div.note-chip' + (state ? '.' + state : ''), h('span', n),
          state ? null : h('span.chip-actions',
            h('button', { onclick: () => { m.noteState = { ...(m.noteState || {}), [j]: 'ok' }; persistConv(); drawThread(); } }, 'ok'),
            h('button', { onclick: () => { m.noteState = { ...(m.noteState || {}), [j]: 'change' }; persistConv(); input.value = `About “${n}”: `; input.focus(); drawThread(); } }, 'change'))));
      }
    }
    if (m.problems?.length) el.append(h('div.warn', `Still has issues: ${m.problems.join(' · ')}`));
    if (m.kind === 'proposal' && i === lastProposalIndex() && pending) {
      el.append(h('button.btn.btn-sm', { onclick: () => { tab = 'changes'; drawRight(); } }, 'Changes ready → review'));
    } else if (m.kind === 'proposal' && m.outcome) {
      el.append(h('div.fine', m.outcome === 'accepted' ? '✓ Accepted' : 'Discarded'));
    }
    return el;
  }
  const lastProposalIndex = () => { for (let i = conv.length - 1; i >= 0; i--) if (conv[i].kind === 'proposal') return i; return -1; };

  function historyForLLM() {
    return conv.filter(m => m.role === 'user' || m.role === 'designer').slice(-6).map(m => m.role === 'user'
      ? { role: 'user', content: m.text }
      : { role: 'assistant', content: [m.summary, ...(m.changes || []).map(c => '- ' + c), ...(m.notes || []).map((n, j) => `(assumption${m.noteState?.[j] === 'ok' ? ', user confirmed' : ''}) ${n}`)].join('\n') });
  }

  async function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!draft && !text) { input.focus(); return; }
    if (draft && !text && !evidence) { input.focus(); return; }
    voice.cancel();
    const history = historyForLLM();
    if (text) conv.push({ role: 'user', text });
    input.value = '';
    const usedEvidence = evidence;
    if (usedEvidence) { const card = [...conv].reverse().find(m => m.role === 'run'); if (card) card.used = true; }
    busy = true; sendBtn.disabled = true;
    persistConv(); drawThread();
    try {
      const out = await designTurn({
        history,
        current: draft ? (pending || draft) : null,
        evidence: usedEvidence,
        request: text,
        startFrom: draft ? null : startFrom,
      }, { useFree: noExtension, ownSlug: draft ? draft.slug : null, existingSlugs: store.list().map(r => r.slug) });
      evidence = null;
      if (!draft) {
        draft = { ...out.draft, slug: store.uniqueSlug(out.draft.slug) };
        conv.push({ role: 'designer', kind: 'draft', summary: out.summary, notes: out.notes, changes: [], problems: out.problems });
        tab = 'try';
      } else {
        const same = JSON.stringify(normalizeManifest(out.draft.manifest)) === JSON.stringify(normalizeManifest(draft.manifest)) && out.draft.prompt === draft.prompt;
        if (same) {
          pending = null;
          conv.push({ role: 'designer', kind: 'note', summary: out.summary || 'No changes needed.', notes: out.notes, changes: [] });
        } else {
          pending = { ...out.draft, slug: draft.slug };
          pendingChanges = out.changes;
          conv.push({ role: 'designer', kind: 'proposal', summary: out.summary, notes: out.notes, changes: out.changes, problems: out.problems });
          tab = 'changes';
        }
      }
    } catch (err) {
      conv.push({ role: 'error', text: designerError(err) });
      if (usedEvidence) evidence = usedEvidence;
    } finally {
      busy = false; sendBtn.disabled = false;
      persistConv(); placeholder(); drawThread(); drawRight();
    }
  }

  function designerError(err) {
    if (err.code === 'extension-missing' || err.code === 'side-panel-message-failed') return extensionErrorText(err);
    if (/api key|apiKey|401|unauthorized/i.test(err.message)) return `${err.message} — check the API key in the extension’s Settings, or clear it to use the free Runbook AI model.`;
    return err.message;
  }

  // ------------------------------------------------------------- draft ---
  function save(note = '') {
    const { errors } = validateRunbook(draft);
    if (errors.length) { toast(errors[0], 'error'); tab = 'manifest'; drawRight(); return false; }
    const r = store.save(draft.slug, { manifest: draft.manifest, prompt: draft.prompt, origin: saved?.origin || { kind: 'designer' } }, note);
    if (r.error) { toast(r.message, 'error'); return false; }
    const wasNew = !saved;
    saved = r.runbook;
    draft = { slug: saved.slug, manifest: saved.manifest, prompt: saved.prompt };
    if (wasNew) {
      // Move the conversation to the runbook's own key and update the URL.
      session.remove(convKey(null));
      persistConv();
      history.replaceState(null, '', `?design=${encodeURIComponent(saved.slug)}`);
    }
    document.title = `${saved.manifest.title} — Designer — Runbook AI`;
    return true;
  }

  function drawRight() {
    clear(right);
    if (!draft) {
      right.append(h('div.draft-empty',
        h('h2', 'Your runbook will appear here'),
        h('p.muted', 'A runbook is a short form (the inputs) plus a prompt the agent follows. Describe what you want on the left.'),
        startFromPicker()));
      return;
    }
    const v = validateRunbook(draft);
    const statusText = pending ? 'Changes proposed' : isDirty() ? 'Unsaved changes' : `Saved · v${saved?.version || 1}`;
    const head = h('div.draft-head',
      h('div.draft-title',
        h('h2', draft.manifest.title || 'Untitled'),
        saved ? h('code.fine', draft.slug)
          : h('input.slug-input', { value: draft.slug, 'aria-label': 'Slug', title: 'Folder name if you share it (lowercase, dashes)', oninput: e => { draft.slug = e.target.value.trim(); } })),
      h('div.draft-actions',
        h('span.save-state' + (isDirty() || pending ? '.dirty' : ''), statusText),
        saved?.versions?.length ? versionMenu() : null,
        h('button.btn.btn-ghost', { disabled: !isDirty(), onclick: () => { if (save('edited')) { toast('Saved.'); drawRight(); } } }, 'Save'),
        h('button.btn.btn-ghost', { onclick: () => exportRunbooks([draft], `${draft.slug}.zip`) }, 'Export'),
        saved ? h('a.btn.btn-ghost', { href: `?local=${encodeURIComponent(saved.slug)}`, 'data-nav': '' }, 'Open run page') : null));
    const tabs = h('div.tabs', ['try', 'prompt', 'manifest', 'changes'].map(id => h('button.tab', {
      role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; drawRight(); },
    }, { try: 'Try it', prompt: 'Prompt', manifest: 'Manifest', changes: pending ? 'Changes •' : 'Changes' }[id])));
    const body = h('div.tab-body');
    if (tab === 'try') drawTry(body);
    else if (tab === 'prompt') drawPrompt(body);
    else if (tab === 'manifest') drawManifest(body, v);
    else drawChanges(body);
    right.append(storageBanner() || '', head, tabs, body);
  }

  function startFromPicker() {
    const sel = h('select', h('option', { value: '' }, 'Start from scratch'));
    const mine = store.list();
    if (mine.length) sel.append(h('optgroup', { label: 'My runbooks' }, mine.map(r => h('option', { value: 'local:' + r.slug }, r.manifest.title))));
    fetch('runbooks.json').then(r => r.json()).then(list => {
      const g = h('optgroup', { label: 'Community' });
      for (const { slug } of list) g.append(h('option', { value: 'repo:' + slug }, slug));
      sel.append(g);
    }).catch(() => {});
    sel.addEventListener('change', async () => {
      const [kind, slug] = sel.value.split(':');
      if (!kind) { startFrom = null; return; }
      try {
        const rb = kind === 'local' ? store.get(slug) : await loadRepoRunbook(slug);
        startFrom = { slug: rb.slug, manifest: rb.manifest, prompt: rb.prompt };
      } catch { startFrom = null; }
    });
    return h('label.start-from', 'Adapt an existing runbook (optional): ', sel);
  }

  function versionMenu() {
    const items = [...saved.versions].reverse().map(ver => h('div.version-item',
      h('div', h('b', `v${ver.version}`), ' ', h('span.fine', timeAgo(ver.at))),
      ver.note ? h('div.fine', ver.note) : null,
      h('button.btn.btn-ghost.btn-sm', {
        onclick: () => {
          if (isDirty() && !confirm('Discard unsaved changes and restore this version?')) return;
          const r = store.restore(saved.slug, ver.version);
          if (r.error) { toast(r.message, 'error'); return; }
          saved = r.runbook; draft = { slug: saved.slug, manifest: saved.manifest, prompt: saved.prompt }; pending = null;
          toast(`Restored v${ver.version} as v${saved.version}.`);
          drawRight();
        },
      }, 'Restore')));
    return h('details.card-more.version-menu', h('summary', `v${saved.version} ▾`), h('div.card-menu.version-list',
      h('div.version-item.current', h('b', `v${saved.version}`), ' current', saved.note ? h('div.fine', saved.note) : null), items));
  }

  function drawTry(body) {
    const status = h('span#status');
    const runBtn = h('button.btn.btn-run', { type: 'button' }, '▶ Test run');
    const form = paramsForm(draft.manifest, { onChange: () => gate() });
    const frame = h('iframe.result-frame', { sandbox: 'allow-popups allow-same-origin', title: 'Test run result' });
    const meta = h('span.result-meta');
    const resultCard = h('div.result-card.hidden', h('div.result-head', h('h3.result-title', 'Result'), meta), frame);
    const gate = () => {
      const missing = form.missing();
      runBtn.disabled = noExtension || busy || missing.length > 0;
      runBtn.title = noExtension ? 'Install the Runbook AI extension to test-run' : missing.length ? `Fill in: ${missing.map(p => p.label || p.name).join(', ')}` : '';
    };
    gate();
    runBtn.onclick = async () => {
      if (pending && !confirm('There are proposed changes you haven’t accepted. Test-run the current version anyway?')) return;
      if (isDirty() && !save('edited before test run')) return;
      runBtn.disabled = true;
      status.textContent = 'Starting…'; status.className = '';
      let resp = null, error = null;
      try {
        resp = await runPrompt({ prompt: buildPrompt(draft.prompt, form), files: form.allFiles(), onTick: s => { status.textContent = `Running… ${s}s (live progress in the side panel)`; } });
        const ok = resp.status === 'completed';
        status.textContent = ok ? `Completed in ${resp.elapsed}s.` : `Finished: ${resp.status}`;
        status.className = ok ? 'success' : 'error';
        renderResult(frame, resp);
        meta.textContent = resultMeta(resp);
        resultCard.classList.remove('hidden');
      } catch (err) {
        error = extensionErrorText(err);
        status.textContent = error; status.className = 'error';
      }
      evidence = await collectEvidence(resp, { values: form.values(), error });
      conv.push({ role: 'run', status: evidence.status, steps: evidence.steps, elapsed: evidence.elapsedSec, resultHead: String(resp?.result || error || '').slice(0, 160), evidence });
      persistConv(); placeholder(); drawThread(); gate();
      input.focus();
    };
    body.append(form.el, h('div.run-row', runBtn, status),
      h('p.fine', 'Test run saves the draft, then runs it exactly like the run page. The result shows up in the conversation so the designer can improve it.'),
      resultCard);
  }

  function drawPrompt(body) {
    const ta = h('textarea.editor', { spellcheck: false, value: draft.prompt });
    ta.addEventListener('input', () => { draft.prompt = ta.value; refreshState(); });
    body.append(h('p.fine', 'The prompt the agent follows. {{name}} placeholders are filled from the form.'), ta);
  }

  function drawManifest(body, v) {
    const ta = h('textarea.editor', { spellcheck: false, value: manifestJson(draft.manifest) });
    const problems = h('div.problems');
    const showProblems = (vv, parseErr) => {
      clear(problems);
      if (parseErr) problems.append(h('div.err', '✕ ' + parseErr));
      for (const e of vv?.errors || []) problems.append(h('div.err', '✕ ' + e));
      for (const w of vv?.warnings || []) problems.append(h('div.warn', '⚠ ' + w));
    };
    showProblems(v);
    ta.addEventListener('input', () => {
      try {
        draft.manifest = JSON.parse(ta.value);
        showProblems(validateRunbook(draft));
      } catch (e) {
        showProblems(null, `Not valid JSON yet: ${e.message}`);
      }
      refreshState();
    });
    body.append(h('p.fine', 'Title, description, setup note and the form fields (params).'), ta, problems);
  }

  function drawChanges(body) {
    if (!pending) { body.append(h('p.muted', 'No proposed changes. Ask the designer for a change, or test-run and send feedback.')); return; }
    const diffBlock = (title, a, b) => {
      const d = lineDiff(a, b);
      if (!d.some(x => x.op !== 'same')) return h('div.diff-block', h('h4', title), h('p.fine', 'No changes.'));
      return h('div.diff-block', h('h4', title), h('pre.diff', d.map(x => h('div.' + x.op, (x.op === 'add' ? '+ ' : x.op === 'del' ? '- ' : '  ') + x.line))));
    };
    body.append(
      pendingChanges.length ? h('ul.changes', pendingChanges.map(c => h('li', c))) : null,
      diffBlock('prompt.md', draft.prompt, pending.prompt),
      diffBlock('manifest.json', manifestJson(draft.manifest), manifestJson(pending.manifest)),
      h('div.row',
        h('button.btn', {
          onclick: () => {
            draft = { ...pending, slug: draft.slug };
            pending = null;
            const note = pendingChanges.join('; ').slice(0, 300) || 'designer changes';
            const m = conv[lastProposalIndex()]; if (m) m.outcome = 'accepted';
            if (saved) save(`designer: ${note}`);
            persistConv(); drawThread(); tab = 'try'; drawRight();
            toast(saved ? `Saved as v${saved.version}.` : 'Applied.');
          },
        }, 'Accept'),
        h('button.btn.btn-ghost', {
          onclick: () => {
            pending = null;
            const m = conv[lastProposalIndex()]; if (m) m.outcome = 'discarded';
            persistConv(); drawThread(); drawRight();
          },
        }, 'Discard')));
  }

  // Update the header's save state without redrawing the editor.
  function refreshState() {
    const el = right.querySelector('.save-state');
    if (el) {
      el.textContent = pending ? 'Changes proposed' : isDirty() ? 'Unsaved changes' : `Saved · v${saved?.version || 1}`;
      el.classList.toggle('dirty', isDirty() || !!pending);
    }
    const saveBtn = [...right.querySelectorAll('.draft-actions button')].find(b => b.textContent === 'Save');
    if (saveBtn) saveBtn.disabled = !isDirty();
  }

  // ---------------------------------------------------------- layout ---
  const switcher = h('div.pane-switch',
    h('button.tab', { 'aria-selected': 'true', onclick: e => showPane('chat', e.target) }, 'Chat'),
    h('button.tab', { 'aria-selected': 'false', onclick: e => showPane('draft', e.target) }, 'Draft'));
  const layout = h('div.designer', { dataset: { pane: 'chat' } }, left, right);
  function showPane(which, btn) {
    layout.dataset.pane = which;
    for (const b of switcher.children) b.setAttribute('aria-selected', String(b === btn));
  }
  clear(main).append(switcher, layout);

  window.onbeforeunload = () => (isDirty() && !saved) ? 'You have an unsaved runbook.' : undefined;

  // Seed from the gallery box or a Run page "Not quite right?" handoff.
  const seed = session.get(SEED_KEY);
  session.remove(SEED_KEY);
  placeholder(); drawThread(); drawRight();
  if (seed && (!seed.slug || seed.slug === saved?.slug)) {
    if (seed.evidence) {
      evidence = seed.evidence;
      conv.push({ role: 'run', status: evidence.status, steps: evidence.steps, elapsed: evidence.elapsedSec, resultHead: String(evidence.result || '').slice(0, 160), evidence, fromRunPage: true });
    }
    input.value = seed.request || '';
    if (input.value || evidence) send();
    else { placeholder(); drawThread(); }
  }
}

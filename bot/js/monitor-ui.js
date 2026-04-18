/**
 * monitor-ui.js — Combined agent & watcher list panel.
 *
 * Exports:
 *   startMonitorUI({ container })  — start 3s render loop, returns cleanup fn
 */

import { getAllTasks, putTask, createTaskRecord } from './task-store.js';
import { cancelTask, pauseTask, resumeTask } from './task-manager.js';
import { extensionCall } from './extension.js';

// ── Time formatting ───────────────────────────────────────────────────────────

function formatMs(ms) {
  if (!ms || ms < 0) return '?';
  if (ms >= 86_400_000) return Math.floor(ms / 86_400_000) + 'd';
  if (ms >= 3_600_000)  return Math.floor(ms / 3_600_000)  + 'h';
  if (ms >= 60_000)     return Math.floor(ms / 60_000)     + 'm';
  return Math.floor(ms / 1000) + 's';
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 5000) return 'just now';
  return formatMs(ms) + ' ago';
}

function timeUntil(isoString) {
  if (!isoString) return '';
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'now';
  return 'in ' + formatMs(ms);
}

// ── Sort order ────────────────────────────────────────────────────────────────

const STATUS_ORDER = { running: 0, queued: 1, watching: 2, waiting: 3, paused: 4 };

function sortKey(task) {
  if (task.type === 'monitor' && task.status === 'waiting') return STATUS_ORDER.watching;
  return STATUS_ORDER[task.status] ?? 5;
}

// ── Load all active agents ────────────────────────────────────────────────────

async function loadAgents() {
  const all = await getAllTasks();
  return all
    .filter(t => ['running', 'queued', 'waiting', 'paused'].includes(t.status))
    .sort((a, b) => sortKey(a) - sortKey(b) || new Date(a.createdAt) - new Date(b.createdAt));
}

// ── Row HTML ──────────────────────────────────────────────────────────────────

function dotClass(task) {
  if (task.status === 'running')                               return 'agent-dot--running';
  if (task.status === 'queued')                                return 'agent-dot--queued';
  if (task.type === 'monitor' && task.status === 'waiting')    return 'agent-dot--watching';
  if (task.status === 'waiting')                               return 'agent-dot--waiting';
  return 'agent-dot--paused';
}

function line2Text(task) {
  const parts = [];
  if (task.type === 'monitor') {
    parts.push('Watch');
    const ms = task.schedule?.intervalMs;
    if (ms) parts.push('polls every ' + formatMs(ms));
    if (task.lastRunAt) parts.push('polled ' + timeAgo(task.lastRunAt));
  } else if (task.schedule) {
    parts.push('Scheduled');
    const ms = task.schedule.intervalMs;
    if (ms) parts.push('every ' + formatMs(ms));
    if (task.status === 'waiting' && task.nextRunAt) parts.push('next ' + timeUntil(task.nextRunAt));
    if (task.status === 'running' && task.lastRunAt) parts.push('running ' + timeAgo(task.lastRunAt));
  } else {
    parts.push('Task');
    if (task.status === 'running' && task.lastRunAt) parts.push('running ' + timeAgo(task.lastRunAt));
    else if (task.status === 'queued') parts.push('queued');
  }
  return parts.join(' · ');
}

function renderRow(task) {
  const label = task.label || task.prompt.slice(0, 60);
  const canPause  = task.schedule && task.status !== 'paused';
  const canResume = task.status === 'paused';

  const row = document.createElement('div');
  row.className = 'agent-row';
  row.dataset.id = task.id;
  row.innerHTML = `
    <div class="agent-row__line1">
      <span class="agent-dot ${dotClass(task)}"></span>
      <span class="agent-row__label" title="${label}">${label}</span>
      <span class="agent-row__actions">
        ${canPause  ? `<button class="agent-btn" data-action="pause"  data-id="${task.id}">Pause</button>`  : ''}
        ${canResume ? `<button class="agent-btn" data-action="resume" data-id="${task.id}">Resume</button>` : ''}
        <button class="agent-btn agent-btn--danger" data-action="cancel" data-id="${task.id}">✕</button>
      </span>
    </div>
    <div class="agent-row__meta">${line2Text(task)}</div>
  `;
  return row;
}

// ── List render (reconcile, not full replace) ─────────────────────────────────

async function renderAgentList(container) {
  const agents = await loadAgents();

  let list = container.querySelector('.agent-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'agent-list';
    // Insert before add-watch-form if present, else append
    const form = container.querySelector('.add-watch-form');
    form ? container.insertBefore(list, form) : container.appendChild(list);
  }

  if (agents.length === 0) {
    list.innerHTML = '<div class="agent-empty">No active agents or watches. Add a watch to get started.</div>';
    return;
  }

  const existingIds = new Set([...list.querySelectorAll('[data-id]')].map(r => r.dataset.id));
  const newIds      = new Set(agents.map(t => t.id));

  // Remove stale rows
  for (const id of existingIds) {
    if (!newIds.has(id)) list.querySelector(`[data-id="${id}"]`)?.remove();
  }

  // Upsert rows in sorted order
  agents.forEach((task, idx) => {
    const existing = list.querySelector(`[data-id="${task.id}"]`);
    const fresh = renderRow(task);
    if (existing) {
      existing.replaceWith(fresh);
    } else {
      const sibling = list.children[idx];
      sibling ? list.insertBefore(fresh, sibling) : list.appendChild(fresh);
    }
  });
}

// ── Action delegation ─────────────────────────────────────────────────────────

function wireActions(container, refresh) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    btn.disabled = true;
    try {
      if (action === 'cancel') await cancelTask(id);
      if (action === 'pause')  await pauseTask(id);
      if (action === 'resume') await resumeTask(id);
    } finally {
      await refresh();
    }
  });
}

// ── Add-watch form ────────────────────────────────────────────────────────────

async function openAddWatchForm(container, refresh) {
  if (container.querySelector('.add-watch-form')) return; // already open

  let tabs = [];
  try {
    const state = await extensionCall('getTaskState', {});
    tabs = state.tabs || [];
  } catch (err) {
    console.warn('[monitor-ui] getTaskState failed:', err.message);
  }

  const tabOptions = tabs.length > 0
    ? tabs.map(t => `<option value="${t.tabId}" data-url="${t.url ?? ''}">${(t.title || t.url || 'Tab ' + t.tabId).slice(0, 60)}</option>`).join('')
    : '<option value="" data-url="">— no tabs found — run a task first to open a tab</option>';

  const form = document.createElement('div');
  form.className = 'add-watch-form';
  form.innerHTML = `
    <h3 class="add-watch-title">New Watch</h3>
    <div class="add-watch-grid">
      <div class="field">
        <label>Tab to watch</label>
        <select id="watchTabSelect">${tabOptions}</select>
      </div>
      <div class="field">
        <label>Label</label>
        <input type="text" id="watchLabel" placeholder="e.g. Slack #team-alerts" />
      </div>
      <div class="field">
        <label>Poll every (seconds)</label>
        <input type="number" id="watchInterval" value="30" min="5" max="3600" />
      </div>
      <div class="field add-watch-full">
        <label>Instruction <span style="font-weight:400;text-transform:none;letter-spacing:0">— what to do when changes are detected</span></label>
        <textarea id="watchInstruction" rows="4" placeholder="e.g. Summarize new messages and draft a reply"></textarea>
      </div>
    </div>
    <div class="add-watch-actions">
      <button class="btn btn-primary" id="watchSubmitBtn">Start Watching</button>
      <button class="btn btn-ghost"   id="watchCancelBtn">Cancel</button>
      <span class="add-watch-err" id="watchErr" style="display:none;color:#dc2626;font-size:0.8125rem;"></span>
    </div>
  `;

  container.appendChild(form);

  form.querySelector('#watchCancelBtn').addEventListener('click', () => form.remove());

  form.querySelector('#watchSubmitBtn').addEventListener('click', async () => {
    const tabSel      = form.querySelector('#watchTabSelect');
    const tabId       = parseInt(tabSel.value, 10);
    const tabUrl      = tabSel.options[tabSel.selectedIndex]?.dataset.url ?? '';
    const label       = form.querySelector('#watchLabel').value.trim();
    const intervalMs  = Math.max(5000, parseInt(form.querySelector('#watchInterval').value, 10) * 1000);
    const instruction = form.querySelector('#watchInstruction').value.trim();
    const errEl       = form.querySelector('#watchErr');

    if (!tabSel.value) { errEl.textContent = 'Select a tab to watch. Run a task first to open tabs.'; errEl.style.display = ''; return; }
    if (!label) { errEl.textContent = 'Label is required.'; errEl.style.display = ''; return; }
    if (!instruction) { errEl.textContent = 'Instruction is required.'; errEl.style.display = ''; return; }

    const task = createTaskRecord({
      type:      'monitor',
      label,
      prompt:    `Monitor: ${label}`,
      status:    'waiting',
      nextRunAt: new Date().toISOString(),
      schedule:  { type: 'every', intervalMs },
      config: {
        tabId,
        tabUrl,
        instruction,
      },
    });

    await putTask(task);
    form.remove();
    await refresh();
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startMonitorUI({ container }) {
  const refresh = () => renderAgentList(container);

  // Wire action clicks once on the container (event delegation)
  wireActions(container, refresh);

  // Wire Add Watch button
  container.querySelector('#addWatchBtn')?.addEventListener('click', () => {
    openAddWatchForm(container, refresh);
  });

  // Initial render + 3s polling
  refresh();
  const timer = setInterval(refresh, 3_000);

  return () => clearInterval(timer);
}

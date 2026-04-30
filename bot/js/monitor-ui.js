/**
 * monitor-ui.js — Combined agent & watcher list panel.
 *
 * Exports:
 *   startMonitorUI({ container })  — start 3s render loop, returns cleanup fn
 */

import { getAllTasks } from './task-store.js';
import { cancelTask, pauseTask, resumeTask } from './task-manager.js';

// ── Time formatting ───────────────────────────────────────────────────────────

export function formatMs(ms) {
  if (!ms || ms < 0) return '?';
  if (ms >= 86_400_000) return Math.floor(ms / 86_400_000) + 'd';
  if (ms >= 3_600_000)  return Math.floor(ms / 3_600_000)  + 'h';
  if (ms >= 60_000)     return Math.floor(ms / 60_000)     + 'm';
  return Math.floor(ms / 1000) + 's';
}

export function timeAgo(isoString) {
  if (!isoString) return '';
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 5000) return 'just now';
  return formatMs(ms) + ' ago';
}

export function timeUntil(isoString) {
  if (!isoString) return '';
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'now';
  return 'in ' + formatMs(ms);
}

// ── Sort order ────────────────────────────────────────────────────────────────

const STATUS_ORDER = { running: 0, queued: 1, watching: 2, waiting: 3, paused: 4 };

export function sortKey(task) {
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

export function dotClass(task) {
  if (task.status === 'running')                               return 'agent-dot--running';
  if (task.status === 'queued')                                return 'agent-dot--queued';
  if (task.type === 'monitor' && task.status === 'waiting')    return 'agent-dot--watching';
  if (task.status === 'waiting')                               return 'agent-dot--waiting';
  return 'agent-dot--paused';
}

export function line2Text(task) {
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
    container.appendChild(list);
  }

  if (agents.length === 0) {
    list.innerHTML = '<div class="agent-empty">No active agents or watches. Ask the bot to watch a page to get started.</div>';
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

// ── Entry point ───────────────────────────────────────────────────────────────

export function startMonitorUI({ container }) {
  const refresh = () => renderAgentList(container);

  // Wire action clicks once on the container (event delegation)
  wireActions(container, refresh);

  // Initial render + 3s polling
  refresh();
  const timer = setInterval(refresh, 3_000);

  return () => clearInterval(timer);
}

/**
 * Local UI chat channel.
 *
 * Provides a browser-native chat interface as an alternative to Discord.
 * Tasks created here use LOCAL_CHANNEL_ID as their channelId so the delivery
 * handler in app.js routes replies back here instead of to Discord.
 */

import {
  createAndEnqueue, listTasks, cancelTask, pauseTask, resumeTask,
} from './task-manager.js';
import { logMessage } from './ui.js';

export const LOCAL_CHANNEL_ID = 'local:ui';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseInterval(str) {
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * multipliers[unit]);
}

function formatMs(ms) {
  if (ms >= 86_400_000) return (ms / 86_400_000).toFixed(1).replace(/\.0$/, '') + 'd';
  if (ms >= 3_600_000)  return (ms / 3_600_000).toFixed(1).replace(/\.0$/, '') + 'h';
  if (ms >= 60_000)     return (ms / 60_000).toFixed(1).replace(/\.0$/, '') + 'm';
  return (ms / 1000).toFixed(0) + 's';
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getContainer() {
  return document.getElementById('localChatMessages');
}

// ── Reply state ───────────────────────────────────────────────────────────────

let pendingReplyTaskId = null;

function setReply(taskId, previewText) {
  pendingReplyTaskId = taskId;
  const banner = document.getElementById('localChatReplyBanner');
  const preview = document.getElementById('localChatReplyPreview');
  if (banner) banner.style.display = 'flex';
  if (preview) preview.textContent = previewText.slice(0, 120);
  document.getElementById('localChatInput')?.focus();
}

function clearReply() {
  pendingReplyTaskId = null;
  const banner = document.getElementById('localChatReplyBanner');
  if (banner) banner.style.display = 'none';
}

/**
 * Append a chat bubble to the local chat panel.
 * role: 'user' | 'bot' | 'system'
 * opts.taskId   — for bot messages: stored as data-task-id to enable reply
 * opts.replyRef — text snippet of the message being replied to (shown as quote)
 */
function appendMessage(content, role, opts = {}) {
  const container = getContainer();
  if (!container) return;

  // Remove empty-state placeholder
  const empty = container.querySelector('.local-chat-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = [
    'log-entry',
    role === 'user'   ? 'local-user'  : '',
    role === 'bot'    ? 'outgoing'    : '',
    role === 'system' ? 'system-msg'  : '',
  ].filter(Boolean).join(' ');

  if (opts.taskId) entry.dataset.taskId = opts.taskId;

  const meta = document.createElement('div');
  meta.className = 'log-meta';

  const authorSpan = document.createElement('span');
  authorSpan.className = [
    'log-author',
    role === 'user'   ? 'user'   : '',
    role === 'bot'    ? 'bot'    : '',
    role === 'system' ? 'system' : '',
  ].filter(Boolean).join(' ');
  authorSpan.textContent = role === 'user' ? 'You' : role === 'bot' ? 'Bot' : 'System';

  const timeSpan = document.createElement('span');
  timeSpan.textContent = new Date().toLocaleTimeString();

  meta.append(authorSpan, timeSpan);

  const msgDiv = document.createElement('div');
  msgDiv.className = 'log-content';

  // Reply reference quote
  if (opts.replyRef) {
    const refDiv = document.createElement('div');
    refDiv.className = 'log-reply-ref';
    refDiv.textContent = opts.replyRef.slice(0, 120);
    msgDiv.appendChild(refDiv);
  }

  const textNode = document.createTextNode(content);
  msgDiv.appendChild(textNode);

  // Reply button for bot messages
  if (role === 'bot' && opts.taskId) {
    const replyBtn = document.createElement('button');
    replyBtn.className = 'reply-btn';
    replyBtn.textContent = '↩ Reply';
    replyBtn.addEventListener('click', () => setReply(opts.taskId, content));
    entry.appendChild(replyBtn);
  }

  entry.append(meta, msgDiv);
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ── Typing indicator ──────────────────────────────────────────────────────────

export function showLocalTyping(show) {
  const el = document.getElementById('localChatTyping');
  if (el) el.style.display = show ? 'flex' : 'none';
}

// ── Delivery target (called from app.js delivery handler) ─────────────────────

export function deliverToLocalUI(task, message) {
  showLocalTyping(false);
  appendMessage(message, 'bot', { taskId: task.id });
  logMessage({ channel_id: LOCAL_CHANNEL_ID, content: message }, 'outgoing');
}

// ── Command handling ──────────────────────────────────────────────────────────

async function handleLocalCommand(content) {
  if (/^!help\s*$/i.test(content)) {
    appendMessage(
      'Commands:\n' +
      '!run <runbook>            — launch a saved runbook\n' +
      '!schedule <interval> <prompt> — schedule a recurring task\n' +
      '!tasks                    — list ongoing + recent tasks\n' +
      '!cancel <id>              — cancel a task\n' +
      '!pause <id>               — pause a scheduled task\n' +
      '!resume <id>              — resume a paused task\n' +
      '!help                     — show this message',
      'bot',
    );
    return;
  }

  if (/^!tasks\s*$/i.test(content)) {
    const allTasks = await listTasks();
    const ongoing = allTasks.filter(t => ['running', 'queued', 'waiting', 'paused'].includes(t.status));
    const finished = allTasks
      .filter(t => (t.status === 'completed' || t.status === 'failed') && !t.parentId)
      .sort((a, b) => (b.lastRunAt || b.updatedAt || '').localeCompare(a.lastRunAt || a.updatedAt || ''))
      .slice(0, 10);

    if (ongoing.length === 0 && finished.length === 0) {
      appendMessage('No tasks.', 'bot');
      return;
    }

    const statusIcon = { running: '▶', queued: '⏳', waiting: '⏰', paused: '⏸', completed: '✅', failed: '❌' };
    const order = { running: 0, queued: 1, waiting: 2, paused: 3, completed: 4, failed: 5 };
    const taskMap = new Map(allTasks.map(t => [t.id, t]));
    const childrenOf = new Map();
    for (const t of allTasks) {
      if (t.parentId) {
        if (!childrenOf.has(t.parentId)) childrenOf.set(t.parentId, []);
        childrenOf.get(t.parentId).push(t);
      }
    }

    function fmt(t, indent) {
      const icon = statusIcon[t.status] || '?';
      const sched = t.schedule ? ` (every ${formatMs(t.schedule.intervalMs)})` : '';
      const max = indent ? 45 : 60;
      const preview = t.prompt.length > max ? t.prompt.slice(0, max - 3) + '...' : t.prompt;
      return `${indent}${icon} ${t.id} [${t.status}]${sched} — ${preview}`;
    }

    function tree(taskId, indent) {
      const t = taskMap.get(taskId);
      if (!t) return [];
      const lines = [fmt(t, indent)];
      const kids = (childrenOf.get(taskId) || [])
        .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
      for (const c of kids) lines.push(...tree(c.id, indent + '  ↳ '));
      return lines;
    }

    const roots = [...ongoing.filter(t => !t.parentId), ...finished];
    roots.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    const seen = new Set();
    const lines = [];
    for (const t of roots) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      lines.push(...tree(t.id, ''));
    }
    appendMessage(lines.join('\n'), 'bot');
    return;
  }

  const scheduleMatch = content.match(/^!schedule\s+(\S+)\s+([\s\S]+)$/i);
  if (scheduleMatch) {
    const intervalMs = parseInterval(scheduleMatch[1]);
    if (!intervalMs) {
      appendMessage(`Invalid interval "${scheduleMatch[1]}". Use format like: 30m, 2h, 1d`, 'bot');
      return;
    }
    const task = await createAndEnqueue({
      prompt:    scheduleMatch[2].trim(),
      config:    {},
      channelId: LOCAL_CHANNEL_ID,
      replyToId: null,
      createdBy: 'local',
      schedule:  { type: 'every', intervalMs },
    });
    appendMessage(
      `Scheduled task \`${task.id}\` to run every ${formatMs(intervalMs)}. First run starting now.`,
      'bot',
    );
    return;
  }

  const cancelMatch = content.match(/^!cancel\s+(\S+)\s*$/i);
  if (cancelMatch) {
    const task = await cancelTask(cancelMatch[1]);
    appendMessage(
      task ? `Cancelled task ${cancelMatch[1]}.` : `Task ${cancelMatch[1]} not found.`,
      'bot',
    );
    return;
  }

  const pauseMatch = content.match(/^!pause\s+(\S+)\s*$/i);
  if (pauseMatch) {
    const task = await pauseTask(pauseMatch[1]);
    appendMessage(
      task
        ? `Paused task ${pauseMatch[1]}. Use !resume ${pauseMatch[1]} to continue.`
        : `Task ${pauseMatch[1]} not found or is not a scheduled task.`,
      'bot',
    );
    return;
  }

  const resumeMatch = content.match(/^!resume\s+(\S+)\s*$/i);
  if (resumeMatch) {
    const task = await resumeTask(resumeMatch[1]);
    appendMessage(
      task
        ? `Resumed task ${resumeMatch[1]}. Next run scheduled.`
        : `Task ${resumeMatch[1]} not found or is not paused.`,
      'bot',
    );
    return;
  }

  const runMatch = content.match(/^!run\s+(\S+)(.*)?$/i);
  if (runMatch) {
    try {
      const runbookName = runMatch[1].trim();
      const extraPrompt = (runMatch[2] ?? '').trim();
      const [mdRes, jsonRes] = await Promise.all([
        fetch(`/runbooks/${runbookName}.md`),
        fetch(`/runbooks/${runbookName}.json`),
      ]);
      if (!mdRes.ok) throw new Error(`Unknown runbook "${runbookName}".`);
      const prompt = (extraPrompt ? `${extraPrompt}\n\n` : '') + await mdRes.text();
      const config = jsonRes.ok ? JSON.parse(await jsonRes.text()) : {};
      await createAndEnqueue({
        prompt, config,
        channelId: LOCAL_CHANNEL_ID,
        replyToId: null,
        createdBy: 'local',
      });
    } catch (err) {
      appendMessage(`Error: ${err.message}`, 'system');
    }
    return;
  }

  appendMessage('Unknown command. Type !help to see available commands.', 'bot');
}

// ── Send handler (called by UI events below) ──────────────────────────────────

export async function handleLocalSend(content) {
  content = content.trim();
  if (!content) return;

  // Capture and clear reply state before any async work
  const replyToId = pendingReplyTaskId;
  const replyRef = replyToId
    ? document.querySelector(`[data-task-id="${replyToId}"] .log-content`)?.textContent?.trim()
    : null;
  clearReply();

  appendMessage(content, 'user', replyRef ? { replyRef } : {});
  logMessage({ channel_id: LOCAL_CHANNEL_ID, content }, 'incoming');

  if (content.startsWith('!')) {
    await handleLocalCommand(content);
    return;
  }

  await createAndEnqueue({
    prompt:    content,
    files:     {},
    config:    {},
    channelId: LOCAL_CHANNEL_ID,
    replyToId: replyToId || null,
    createdBy: 'local',
  });
}

// ── DOM wiring ────────────────────────────────────────────────────────────────

function initDom() {
  const input   = document.getElementById('localChatInput');
  const sendBtn = document.getElementById('localChatSend');
  if (!input || !sendBtn) return;

  document.getElementById('localChatCancelReply')?.addEventListener('click', clearReply);

  sendBtn.addEventListener('click', async () => {
    const content = input.value;
    input.value = '';
    input.style.height = '';
    await handleLocalSend(content);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Auto-grow textarea up to 150px
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  });
}

// ES modules are deferred — DOM may already be ready when this runs
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDom);
} else {
  initDom();
}

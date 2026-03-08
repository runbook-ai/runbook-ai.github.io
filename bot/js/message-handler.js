import { loadSettings, getAllowedUsers, PROXY_URL } from './settings.js';
import { logMessage, logSystem } from './ui.js';
import {
  sendDiscordMessage, addReaction, openDMChannel,
  fetchDiscordMessage,
} from './discord.js';
import {
  createAndEnqueue, listTasks, cancelTask,
  pauseTask, resumeTask, removeTask, applyFollowUp,
} from './task-manager.js';
import { putMessageMapping, getMessageMapping } from './task-store.js';

// ── Interval parsing ────────────────────────────────────────────────────────

/** Parse a human-friendly interval like "2h", "30m", "1d" into milliseconds. */
function parseInterval(str) {
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n    = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * multipliers[unit]);
}

/** Format ms to human-readable. */
function formatMs(ms) {
  if (ms >= 86_400_000)  return (ms / 86_400_000).toFixed(1).replace(/\.0$/, '') + 'd';
  if (ms >= 3_600_000)   return (ms / 3_600_000).toFixed(1).replace(/\.0$/, '') + 'h';
  if (ms >= 60_000)      return (ms / 60_000).toFixed(1).replace(/\.0$/, '') + 'm';
  return (ms / 1000).toFixed(0) + 's';
}

// ── Reply-chain tracing ────────────────────────────────────────────────────

/**
 * Walk up the Discord reply chain to find the task ID this message belongs to.
 * Returns the task ID or null if this is a new conversation.
 */
async function traceTaskFromReply(msg, token) {
  let refId = msg.message_reference?.message_id;
  const visited = new Set();

  while (refId && !visited.has(refId)) {
    visited.add(refId);

    // Check if this message is mapped to a task
    const mapping = await getMessageMapping(refId);
    if (mapping) return mapping.taskId;

    // Fetch the referenced message to continue the chain
    const refMsg = await fetchDiscordMessage(msg.channel_id, refId, token);
    if (!refMsg) break;
    refId = refMsg.message_reference?.message_id;
  }

  return null;
}

// ── Attachment downloading ─────────────────────────────────────────────────

const ATTACHMENT_MAX_SIZE = 3 * 1024 * 1024; // 3 MB — matches extension downloadFile limit

/**
 * Download Discord attachments into a savedFiles-compatible map.
 * Skips files over the size limit.
 *
 * @param {Array} attachments - Discord message attachments array
 * @returns {Promise<object>} Map of { filename: { name, mimeType, base64, size } }
 */
async function downloadAttachments(attachments) {
  const files = {};
  if (!attachments?.length) return files;

  for (const att of attachments) {
    if (att.size > ATTACHMENT_MAX_SIZE) {
      console.warn(`[handler] skipping attachment ${att.filename} (${att.size} bytes > 3 MB limit)`);
      continue;
    }
    try {
      // Route through CORS proxy to bypass Discord CDN restrictions
      const resp = await fetch(`${PROXY_URL}?url=${encodeURIComponent(att.url)}`);
      if (!resp.ok) {
        console.warn(`[handler] proxy fetch failed for ${att.filename}: HTTP ${resp.status}`);
        continue;
      }
      const blob = await resp.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      files[att.filename] = {
        name: att.filename,
        mimeType: att.content_type || blob.type || 'application/octet-stream',
        base64,
        size: blob.size,
      };
      console.log(`[handler] downloaded ${att.filename} (${blob.size} bytes)`);
    } catch (err) {
      console.warn(`[handler] error downloading ${att.filename}:`, err);
    }
  }
  return files;
}

// ── Message handling ────────────────────────────────────────────────────────

/**
 * Handle an incoming Discord MESSAGE_CREATE event.
 *
 * @param {object} msg       - Discord message object from the Gateway
 * @param {string} botUserId - The bot's own user ID (to skip self-messages)
 */
export async function handleMessageCreate(msg, botUserId) {
  if (msg.guild_id) return;
  if (msg.author?.id === botUserId) return;
  if (msg.author?.bot) return;

  const allowedUsers = getAllowedUsers();
  if (!allowedUsers.has(msg.author?.username?.toLowerCase())) return;

  const hasAttachments = msg.attachments?.length > 0;
  if (!msg.content?.trim() && !hasAttachments) {
    logSystem(
      'Received a message with empty content. ' +
      'Enable the MESSAGE_CONTENT privileged intent in your Discord application settings ' +
      '(discord.com/developers > Your App > Bot > Privileged Gateway Intents).',
      'error-msg'
    );
    return;
  }

  logMessage(msg, 'incoming');

  const s = loadSettings();

  let channelId = msg.channel_id;
  try {
    channelId = await openDMChannel(msg.author.id, s.botToken);
  } catch (e) {
    console.warn('[dm] openDMChannel failed:', e.message);
    logSystem(`Could not open DM channel: ${e.message}`, 'error-msg');
  }

  const content = msg.content.trim();

  // ── Commands ──────────────────────────────────────────────────────────

  if (/^!help\s*$/i.test(content)) {
    const help =
      'Send me a message and I\'ll run it as a task.\n\n' +
      '**Commands:**\n' +
      '`!run <runbook>` - launch a saved runbook\n' +
      '`!schedule <interval> <prompt>` - schedule a recurring task\n' +
      '  e.g. `!schedule 2h check gmail for car replies`\n' +
      '`!tasks` - list ongoing + recent tasks (`!tasks all` for full history)\n' +
      '`!cancel <id>` - cancel a task\n' +
      '`!pause <id>` - pause a scheduled task\n' +
      '`!resume <id>` - resume a paused task\n' +
      '`!remove <id>` - delete a task entirely\n' +
      '`!help` - show this message';
    await sendDiscordMessage(channelId, help, s.botToken, msg.id);
    logMessage({ channel_id: channelId, content: help }, 'outgoing');
    return;
  }

  // !tasks [all] — list tasks (ongoing by default, or all)
  const tasksMatch = content.match(/^!tasks(?:\s+(all))?\s*$/i);
  if (tasksMatch) {
    await handleTasksCommand(channelId, msg.id, s, !!tasksMatch[1]);
    return;
  }

  // !schedule <interval> <prompt>
  const scheduleMatch = content.match(/^!schedule\s+(\S+)\s+([\s\S]+)$/i);
  if (scheduleMatch) {
    await handleScheduleCommand(msg, channelId, scheduleMatch[1], scheduleMatch[2].trim(), s);
    return;
  }

  // !cancel <id>
  const cancelMatch = content.match(/^!cancel\s+(\S+)\s*$/i);
  if (cancelMatch) {
    await handleCancelCommand(channelId, msg.id, cancelMatch[1], s);
    return;
  }

  // !pause <id>
  const pauseMatch = content.match(/^!pause\s+(\S+)\s*$/i);
  if (pauseMatch) {
    await handlePauseCommand(channelId, msg.id, pauseMatch[1], s);
    return;
  }

  // !resume <id>
  const resumeMatch = content.match(/^!resume\s+(\S+)\s*$/i);
  if (resumeMatch) {
    await handleResumeCommand(channelId, msg.id, resumeMatch[1], s);
    return;
  }

  // !remove <id>
  const removeMatch = content.match(/^!remove\s+(\S+)\s*$/i);
  if (removeMatch) {
    await removeTask(removeMatch[1]);
    await sendDiscordMessage(channelId, `Removed task \`${removeMatch[1]}\`.`, s.botToken, msg.id);
    return;
  }

  // !run <runbook-name> [extra prompt text]
  const runMatch = content.match(/^!run\s+(\S+)(.*)?$/i);
  if (runMatch) {
    await handleRunCommand(msg, channelId, runMatch[1].trim(), (runMatch[2] ?? '').trim(), s);
    return;
  }

  // Unknown !command
  if (content.startsWith('!')) {
    const unknown = `Unknown command. Type \`!help\` to see available commands.`;
    await sendDiscordMessage(channelId, unknown, s.botToken, msg.id);
    logMessage({ channel_id: channelId, content: unknown }, 'outgoing');
    return;
  }

  // ── Free-form message ─────────────────────────────────────────────────

  // Check if this is a reply to an existing task (follow-up)
  if (msg.message_reference) {
    console.log('[message-handler] reply detected, ref:', msg.message_reference.message_id);
    const taskId = await traceTaskFromReply(msg, s.botToken);
    if (taskId) {
      console.log('[message-handler] follow-up for task:', taskId);
      await handleFollowUp(taskId, msg, channelId, s);
      return;
    }
    console.log('[message-handler] reply chain did not resolve to a task, treating as new');
  }

  // New task — download any attachments first
  addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken); // 👍
  const files = await downloadAttachments(msg.attachments);
  const task = await createAndEnqueue({
    prompt:    content || '(see attached files)',
    files,
    config:    {},
    channelId,
    replyToId: msg.id,
    createdBy: msg.author?.username,
  });
  // Record user's message → task mapping
  await putMessageMapping(msg.id, task.id);
}

// ── Follow-up handler ────────────────────────────────────────────────────────

async function handleFollowUp(taskId, msg, channelId, s) {
  addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken); // 👍

  // Record this message in the mapping
  await putMessageMapping(msg.id, taskId);

  // Download any new attachments
  const files = await downloadAttachments(msg.attachments);

  // Append to conversation history and re-enqueue for immediate execution.
  // The planner will see the full conversation and respond accordingly.
  const task = await applyFollowUp(taskId, msg.content.trim(), msg.id, files);
  if (!task) {
    await sendDiscordMessage(channelId, 'Could not find the related task.', s.botToken, msg.id);
    return;
  }
}

// ── Command handlers ────────────────────────────────────────────────────────

async function handleRunCommand(msg, channelId, runbookName, extraPrompt, s) {
  try {
    const [mdRes, jsonRes] = await Promise.all([
      fetch(`/runbooks/${runbookName}.md`),
      fetch(`/runbooks/${runbookName}.json`),
    ]);

    if (!mdRes.ok) {
      throw new Error(`Unknown runbook "${runbookName}". Try: craigslist-car-listings`);
    }

    const prompt = (extraPrompt ? `${extraPrompt}\n\n` : '') + await mdRes.text();
    const config = jsonRes.ok ? JSON.parse(await jsonRes.text()) : {};

    addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken);
    const task = await createAndEnqueue({
      prompt,
      config,
      channelId,
      replyToId: msg.id,
      createdBy: msg.author?.username,
    });
    await putMessageMapping(msg.id, task.id);
  } catch (err) {
    logSystem(err.message, 'error-msg');
    try { await sendDiscordMessage(channelId, `Error: ${err.message}`, s.botToken, msg.id); } catch {}
  }
}

async function handleScheduleCommand(msg, channelId, intervalStr, prompt, s) {
  const intervalMs = parseInterval(intervalStr);
  if (!intervalMs) {
    await sendDiscordMessage(
      channelId,
      `Invalid interval "${intervalStr}". Use format like: 30m, 2h, 1d`,
      s.botToken, msg.id,
    );
    return;
  }

  addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken);
  const task = await createAndEnqueue({
    prompt,
    config:    {},
    channelId,
    replyToId: msg.id,
    createdBy: msg.author?.username,
    schedule:  { type: 'every', intervalMs },
  });
  await putMessageMapping(msg.id, task.id);

  const reply = `Scheduled task \`${task.id}\` to run every ${formatMs(intervalMs)}.\nFirst run starting now.`;
  const sent = await sendDiscordMessage(channelId, reply, s.botToken, msg.id);
  if (sent?.id) await putMessageMapping(sent.id, task.id);
  logMessage({ channel_id: channelId, content: reply }, 'outgoing');
}

async function handleTasksCommand(channelId, replyToId, s, showAll = false) {
  let tasks = await listTasks();

  if (!showAll) {
    // Show all ongoing tasks + up to 10 most recent finished tasks
    const ongoing = tasks.filter(t => ['running', 'queued', 'waiting', 'paused'].includes(t.status));
    const finished = tasks
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => (b.lastRunAt || b.updatedAt || 0) - (a.lastRunAt || a.updatedAt || 0))
      .slice(0, 10);
    tasks = [...ongoing, ...finished];
  }

  if (tasks.length === 0) {
    const hint = showAll ? 'No tasks.' : 'No tasks. Use `!tasks all` to see full history.';
    await sendDiscordMessage(channelId, hint, s.botToken, replyToId);
    return;
  }

  // Sort: running first, then queued, waiting, paused, then completed/failed
  const order = { running: 0, queued: 1, waiting: 2, paused: 3, completed: 4, failed: 5 };
  tasks.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const lines = tasks.slice(0, 15).map(t => {
    const statusIcon = {
      running: '▶',  queued: '⏳', waiting: '⏰',
      paused: '⏸',  completed: '✅', failed: '❌',
    }[t.status] || '?';
    const sched = t.schedule ? ` (every ${formatMs(t.schedule.intervalMs)})` : '';
    const promptPreview = t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt;
    return `${statusIcon} \`${t.id}\` **${t.status}**${sched} — ${promptPreview}`;
  });

  if (tasks.length > 15) lines.push(`...and ${tasks.length - 15} more`);
  if (!showAll) lines.push('_Use `!tasks all` to see full history._');

  await sendDiscordMessage(channelId, lines.join('\n'), s.botToken, replyToId);
}

async function handleCancelCommand(channelId, replyToId, id, s) {
  const task = await cancelTask(id);
  const reply = task
    ? `Cancelled task \`${id}\`.`
    : `Task \`${id}\` not found.`;
  await sendDiscordMessage(channelId, reply, s.botToken, replyToId);
}

async function handlePauseCommand(channelId, replyToId, id, s) {
  const task = await pauseTask(id);
  const reply = task
    ? `Paused task \`${id}\`. Use \`!resume ${id}\` to continue.`
    : `Task \`${id}\` not found or is not a scheduled task.`;
  await sendDiscordMessage(channelId, reply, s.botToken, replyToId);
}

async function handleResumeCommand(channelId, replyToId, id, s) {
  const task = await resumeTask(id);
  const reply = task
    ? `Resumed task \`${id}\`. Next run scheduled.`
    : `Task \`${id}\` not found or is not paused.`;
  await sendDiscordMessage(channelId, reply, s.botToken, replyToId);
}

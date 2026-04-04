import { loadSettings, getAllowedUsers } from './settings.js';
import { logMessage, logSystem } from './ui.js';
import {
  sendDiscordMessage, addReaction, openDMChannel,
  fetchDiscordMessage,
} from './discord.js';
import { proxyFetch } from './proxy.js';
import {
  createAndEnqueue, listTasks, cancelTask,
  pauseTask, resumeTask,
  findRootTaskByReplyToId, findTaskByChainMessageIds, continueTask,
} from './task-manager.js';

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

// ── Reply-chain conversation builder ──────────────────────────────────────

/**
 * Walk up the Discord reply chain and collect the conversation as
 * { role: 'user'|'assistant', content } turns (oldest first).
 * Returns the conversation array, or [] if no reply chain.
 */
async function collectReplyChain(msg, botUserId, token) {
  const turns = [];
  const files = {};
  let refId = msg.message_reference?.message_id;
  const visited = new Set();
  while (refId && !visited.has(refId)) {
    visited.add(refId);
    const refMsg = await fetchDiscordMessage(msg.channel_id, refId, token);
    if (!refMsg) break;

    const role = refMsg.author?.id === botUserId ? 'assistant' : 'user';
    const text = refMsg.content?.trim() || '';

    // Download attachments from this message in the chain
    const msgFiles = await downloadAttachments(refMsg.attachments);
    Object.assign(files, msgFiles);

    // Build content: text-only or multimodal with images
    const imageEntries = Object.entries(msgFiles).filter(([, f]) => f.mimeType?.startsWith('image/'));
    if (imageEntries.length > 0) {
      const parts = [];
      if (text) parts.push({ type: 'text', text });
      for (const [name, f] of imageEntries) {
        parts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } });
        parts.push({ type: 'text', text: `(image: ${name})` });
      }
      turns.unshift({ role, content: parts });
    } else if (text) {
      turns.unshift({ role, content: text });
    }

    refId = refMsg.message_reference?.message_id;
  }

  return { turns, files };
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
      const resp = await proxyFetch(att.url);
      if (!resp.ok) {
        console.warn(`[handler] proxy fetch failed for ${att.filename}: HTTP ${resp.status}`);
        continue;
      }
      const blob = await resp.blob();
      if (blob.size > ATTACHMENT_MAX_SIZE) {
        console.warn(`[handler] skipping attachment ${att.filename} (actual size ${blob.size} bytes > 3 MB limit)`);
        continue;
      }
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      // Process in 8 KB chunks to avoid call-stack overflow on large files
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 8192) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
      }
      const base64 = btoa(chunks.join(''));
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

// ── Reply chain root finder ──────────────────────────────────────────────────

/**
 * Walk up the Discord reply chain to find the root message ID.
 * The root is the first message in the chain that has no message_reference
 * (i.e. the original user message that started the conversation).
 */
/**
 * Walk up the Discord reply chain to find the root message ID.
 * Returns { rootId, visitedIds } where visitedIds includes all messages in the chain.
 */
async function findRootMessageId(msg, botUserId, token) {
  let refId = msg.message_reference?.message_id;
  const visited = new Set();
  let lastId = refId;
  console.log(`[handler] walking reply chain from ${msg.id}, first ref: ${refId}`);
  while (refId && !visited.has(refId)) {
    visited.add(refId);
    // Small delay between fetches to avoid Discord rate limits on long chains
    if (visited.size > 1) await new Promise(r => setTimeout(r, 300));
    const refMsg = await fetchDiscordMessage(msg.channel_id, refId, token);
    if (!refMsg) {
      console.warn(`[handler] fetchDiscordMessage returned null for ${refId}, stopping walk`);
      break;
    }
    lastId = refId;
    const nextRef = refMsg.message_reference?.message_id;
    console.log(`[handler] chain: ${refId} (${refMsg.author?.bot ? 'bot' : 'user'}) → ${nextRef || 'ROOT'}`);
    refId = nextRef;
  }
  console.log(`[handler] root message: ${lastId}`);
  return { rootId: lastId || null, visitedIds: visited };
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
      '`!tasks` - list ongoing + recent tasks\n' +
      '`!cancel <id>` - cancel a task\n' +
      '`!pause <id>` - pause a scheduled task\n' +
      '`!resume <id>` - resume a paused task\n' +
      '`!help` - show this message';
    await sendDiscordMessage(channelId, help, s.botToken, msg.id);
    logMessage({ channel_id: channelId, content: help }, 'outgoing');
    return;
  }

  // !tasks — list tasks
  if (/^!tasks\s*$/i.test(content)) {
    await handleTasksCommand(channelId, msg.id, s);
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

  addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken); // 👍
  const files = await downloadAttachments(msg.attachments);

  // If replying to a message, try to find the existing root task
  if (msg.message_reference) {
    const { rootId, visitedIds } = await findRootMessageId(msg, botUserId, s.botToken);
    let rootTask = rootId ? await findRootTaskByReplyToId(rootId) : null;
    // Fallback: if chain walk stopped early or root is a bot message,
    // search by __lastReplyToId matching any message in the walked chain
    if (!rootTask && visitedIds.size > 0) {
      rootTask = await findTaskByChainMessageIds(visitedIds);
      if (rootTask) console.log(`[handler] fallback matched task ${rootTask.id} via __lastReplyToId`);
    }
    if (rootTask) {
      await continueTask(rootTask, content || '(see attached files)', {
        files,
        replyToId: msg.id,
      });
      return;
    }

    // No existing task found — fall through to create a new task with reply chain history
    const { turns: history, files: chainFiles } = await collectReplyChain(msg, botUserId, s.botToken);
    const context = {};
    if (history.length > 0) {
      context.history = history;
    }

    await createAndEnqueue({
      prompt:    content || '(see attached files)',
      files:     { ...chainFiles, ...files },
      config:    {},
      channelId,
      replyToId: msg.id,
      createdBy: msg.author?.username,
      context,
    });
    return;
  }

  // No reply — create a fresh task
  await createAndEnqueue({
    prompt:    content || '(see attached files)',
    files:     { ...files },
    config:    {},
    channelId,
    replyToId: msg.id,
    createdBy: msg.author?.username,
  });
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
  const reply = `Scheduled task \`${task.id}\` to run every ${formatMs(intervalMs)}.\nFirst run starting now.`;
  await sendDiscordMessage(channelId, reply, s.botToken, msg.id);
  logMessage({ channel_id: channelId, content: reply }, 'outgoing');
}

async function handleTasksCommand(channelId, replyToId, s) {
  const allTasks = await listTasks();

  // Show all ongoing tasks + up to 10 most recent finished root tasks
  const ongoing = allTasks.filter(t => ['running', 'queued', 'waiting', 'paused'].includes(t.status));
  const finished = allTasks
    .filter(t => (t.status === 'completed' || t.status === 'failed') && !t.parentId)
    .sort((a, b) => (b.lastRunAt || b.updatedAt || '').localeCompare(a.lastRunAt || a.updatedAt || ''))
    .slice(0, 10);
  const rootIds = new Set([...ongoing, ...finished].filter(t => !t.parentId).map(t => t.id));

  if (rootIds.size === 0 && ongoing.length === 0) {
    await sendDiscordMessage(channelId, 'No tasks.', s.botToken, replyToId);
    return;
  }

  // Build task map and children lookup
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const childrenOf = new Map();
  for (const t of allTasks) {
    if (t.parentId) {
      if (!childrenOf.has(t.parentId)) childrenOf.set(t.parentId, []);
      childrenOf.get(t.parentId).push(t);
    }
  }

  const statusIcon = {
    running: '▶',  queued: '⏳', waiting: '⏰',
    paused: '⏸',  completed: '✅', failed: '❌',
  };
  const order = { running: 0, queued: 1, waiting: 2, paused: 3, completed: 4, failed: 5 };

  function formatTask(t, indent) {
    const icon = statusIcon[t.status] || '?';
    const sched = t.schedule ? ` (every ${formatMs(t.schedule.intervalMs)})` : '';
    const maxPrompt = indent ? 45 : 60;
    const promptPreview = t.prompt.length > maxPrompt ? t.prompt.slice(0, maxPrompt - 3) + '...' : t.prompt;
    return `${indent}${icon} \`${t.id}\` **${t.status}**${sched} — ${promptPreview}`;
  }

  function renderTree(taskId, indent) {
    const t = taskMap.get(taskId);
    if (!t) return [];
    const lines = [formatTask(t, indent)];
    const children = childrenOf.get(taskId) || [];
    children.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    for (const child of children) {
      lines.push(...renderTree(child.id, indent + '  ↳ '));
    }
    return lines;
  }

  // Collect visible root tasks (ongoing + recent finished), sorted
  const roots = [...ongoing.filter(t => !t.parentId), ...finished];
  roots.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  // Deduplicate
  const seen = new Set();
  const lines = [];
  for (const t of roots) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    lines.push(...renderTree(t.id, ''));
  }

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

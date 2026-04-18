import { loadSettings, getAllowedUsers } from './settings.js';
import { logMessage, logSystem } from './ui.js';
import {
  sendDiscordMessage, addReaction,
  fetchDiscordMessage, fetchChannel, fetchChannelMessages,
} from './discord.js';
import { proxyFetch } from './proxy.js';
import {
  createAndEnqueue, listTasks, cancelTask,
  pauseTask, resumeTask,
  findRootTaskByReplyToId, findTaskByChainMessageIds, continueTask,
} from './task-manager.js';
import { triage } from './triage.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

// Strip inline-code backticks and quotes from ids pasted back from !tasks
// output, where ids are rendered as `xxxxx`.
function normalizeId(raw) {
  return (raw ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
}

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

// ── Channel mode detection ──────────────────────────────────────────────────

/** Cache: channelId → { mode: 'dm'|'group', participants: [{id,username,isBot}] } */
const channelInfoCache = new Map();

/**
 * Detect whether a channel is 1:1 DM or group DM and cache participants.
 * Uses Discord REST API on first call, then caches forever (channel IDs are
 * stable — adding participants creates a new channel).
 * If forceGroupMode is enabled in settings, forces group mode.
 */
async function getChannelInfo(channelId, token) {
  const s = loadSettings();

  if (!channelInfoCache.has(channelId)) {
    const channel = await fetchChannel(channelId, token);
    const mode = (s.forceGroupMode || channel?.type === 3) ? 'group' : 'dm';
    const participants = (channel?.recipients || []).map(r => ({
      id: r.id,
      username: r.username,
      isBot: !!r.bot,
    }));
    channelInfoCache.set(channelId, { mode, participants });
    console.log(`[handler] channel ${channelId} mode: ${mode} (type=${channel?.type}, participants: ${participants.map(p => p.username).join(', ')})`);
  }

  const cached = channelInfoCache.get(channelId);
  // forceGroupMode can be toggled at runtime, so always check
  if (s.forceGroupMode && cached.mode !== 'group') {
    cached.mode = 'group';
  }
  return cached;
}

/** Get just the channel mode. */
async function getChannelMode(channelId, token) {
  return (await getChannelInfo(channelId, token)).mode;
}

/** Get cached participants for a channel. */
async function getChannelParticipants(channelId, token) {
  return (await getChannelInfo(channelId, token)).participants;
}

// ── Channel buffer ──────────────────────────────────────────────────────────

const BUFFER_SIZE = 50;

/** Per-channel rolling buffer of recent messages. */
const channelBuffers = new Map();

/** Create a buffer entry from a Discord message object. */
function toBufferEntry(msg) {
  return {
    author:    msg.author?.username ?? 'unknown',
    authorId:  msg.author?.id ?? '',
    isBot:     !!msg.author?.bot,
    content:   msg.content ?? '',
    timestamp: msg.timestamp ?? new Date().toISOString(),
    messageId: msg.id,
  };
}

/** Append a message to the channel buffer (capped at BUFFER_SIZE). */
function bufferAppend(channelId, entry) {
  if (!channelBuffers.has(channelId)) channelBuffers.set(channelId, []);
  const buf = channelBuffers.get(channelId);
  buf.push(entry);
  if (buf.length > BUFFER_SIZE) buf.shift();
}

/** Get the channel buffer (or empty array). */
function getBuffer(channelId) {
  return channelBuffers.get(channelId) ?? [];
}

/**
 * Lazy backfill: if buffer is empty, fetch last 50 messages from Discord
 * and populate the buffer (oldest first).
 */
async function ensureBuffer(channelId, token) {
  if (channelBuffers.has(channelId) && channelBuffers.get(channelId).length > 0) return;

  const messages = await fetchChannelMessages(channelId, token, BUFFER_SIZE);
  if (!messages.length) return;

  // Discord returns newest first, reverse for chronological order
  const entries = messages.reverse().map(toBufferEntry);
  channelBuffers.set(channelId, entries);
  console.log(`[handler] backfilled ${entries.length} messages for channel ${channelId}`);
}

// ── Front-mention parsing ───────────────────────────────────────────────────

/**
 * Parse leading mentions from a message.
 * Returns { frontMentions: string[], body: string }
 * where frontMentions are the user IDs mentioned at the start.
 */
function parseFrontMentions(content) {
  const mentionPattern = /^(\s*<@!?(\d+)>\s*)+/;
  const match = content.match(mentionPattern);
  if (!match) return { frontMentions: [], body: content.trim() };

  const prefix = match[0];
  const body = content.slice(prefix.length).trim();
  const idPattern = /<@!?(\d+)>/g;
  const frontMentions = [];
  let m;
  while ((m = idPattern.exec(prefix)) !== null) {
    frontMentions.push(m[1]);
  }
  return { frontMentions, body };
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
 * @param {object} msg         - Discord message object from the Gateway
 * @param {string} botUserId   - The bot's own user ID (to skip self-messages)
 * @param {string} botUsername  - The bot's display name (for triager context)
 */
export async function handleMessageCreate(msg, botUserId, botUsername) {
  // Always skip own messages
  if (msg.author?.id === botUserId) return;

  const s = loadSettings();
  const channelId = msg.channel_id;
  const mode = await getChannelMode(channelId, s.botToken);

  if (mode === 'dm') {
    await handleDM(msg, botUserId, s);
  } else {
    await handleGroupDM(msg, botUserId, botUsername, s);
  }
}

// ── 1:1 DM handler (existing logic, unchanged) ─────────────────────────────

async function handleDM(msg, botUserId, s) {
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

  const channelId = msg.channel_id;
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

  if (/^!tasks\s*$/i.test(content)) {
    await handleTasksCommand(channelId, msg.id, s);
    return;
  }

  const scheduleMatch = content.match(/^!schedule\s+(\S+)\s+([\s\S]+)$/i);
  if (scheduleMatch) {
    await handleScheduleCommand(msg, channelId, scheduleMatch[1], scheduleMatch[2].trim(), s);
    return;
  }

  const cancelMatch = content.match(/^!cancel\s+(\S+)\s*$/i);
  if (cancelMatch) {
    await handleCancelCommand(channelId, msg.id, normalizeId(cancelMatch[1]), s);
    return;
  }

  const pauseMatch = content.match(/^!pause\s+(\S+)\s*$/i);
  if (pauseMatch) {
    await handlePauseCommand(channelId, msg.id, normalizeId(pauseMatch[1]), s);
    return;
  }

  const resumeMatch = content.match(/^!resume\s+(\S+)\s*$/i);
  if (resumeMatch) {
    await handleResumeCommand(channelId, msg.id, normalizeId(resumeMatch[1]), s);
    return;
  }

  const runMatch = content.match(/^!run\s+(\S+)(.*)?$/i);
  if (runMatch) {
    await handleRunCommand(msg, channelId, runMatch[1].trim(), (runMatch[2] ?? '').trim(), s);
    return;
  }

  if (content.startsWith('!')) {
    const unknown = `Unknown command. Type \`!help\` to see available commands.`;
    await sendDiscordMessage(channelId, unknown, s.botToken, msg.id);
    logMessage({ channel_id: channelId, content: unknown }, 'outgoing');
    return;
  }

  // ── Free-form message ─────────────────────────────────────────────────

  addReaction(channelId, msg.id, '%F0%9F%91%8D', s.botToken); // 👍
  const files = await downloadAttachments(msg.attachments);

  if (msg.message_reference) {
    const { rootId, visitedIds } = await findRootMessageId(msg, botUserId, s.botToken);
    let rootTask = rootId ? await findRootTaskByReplyToId(rootId) : null;
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

  await createAndEnqueue({
    prompt:    content || '(see attached files)',
    files:     { ...files },
    config:    {},
    channelId,
    replyToId: msg.id,
    createdBy: msg.author?.username,
  });
}

// ── Group DM handler ────────────────────────────────────────────────────────

async function handleGroupDM(msg, botUserId, botUsername, s) {
  const channelId = msg.channel_id;
  const content = (msg.content ?? '').trim();

  // Ignore reply-linked messages in group mode (except commands we sent)
  if (msg.message_reference) return;

  logMessage(msg, 'incoming');

  const { frontMentions, body } = parseFrontMentions(content);

  // ── Command path: body starts with "!" ────────────────────────────────
  if (body.startsWith('!')) {
    // Determine if this bot should handle the command
    if (frontMentions.length > 0 && !frontMentions.includes(botUserId)) {
      // Mentions in front, but not this bot — ignore
      return;
    }
    // No front mentions or this bot is mentioned — handle command
    await handleGroupCommand(msg, channelId, body, s);
    return;
  }

  // ── Triage path: non-command messages ─────────────────────────────────

  // Ensure buffer is populated (lazy backfill on first message after refresh)
  await ensureBuffer(channelId, s.botToken);

  // Append to channel buffer
  bufferAppend(channelId, toBufferEntry(msg));

  // Get channel participants and active tasks
  const participants = await getChannelParticipants(channelId, s.botToken);
  const allTasks = await listTasks();
  const activeTasks = allTasks
    .filter(t =>
      t.channelId === channelId &&
      ['running', 'queued', 'waiting', 'paused'].includes(t.status)
    )
    .map(t => ({ id: t.id, prompt: t.prompt, label: t.label || null }));

  // Call triager
  let actions;
  try {
    actions = await triage({
      botUsername: botUsername || 'RunbookAI',
      buffer: getBuffer(channelId),
      latestMsg: toBufferEntry(msg),
      activeTasks,
      participants,
    });
  } catch (err) {
    console.error('[handler] triage failed:', err);
    logSystem(`Triage error: ${err.message}`, 'error-msg');
    return;
  }

  // Execute triage actions
  for (const action of actions) {
    switch (action.action) {
      case 'skip':
        console.log(`[handler] triage skip: ${action.reason}`);
        break;

      case 'add_task':
        console.log(`[handler] triage add_task: ${action.reason}`);
        await createAndEnqueue({
          prompt:      action.prompt,
          label:       action.label || null,
          config:      {},
          channelId,
          replyToId:   null, // flat in group mode
          createdBy:   msg.author?.username,
          channelMode: 'group',
          context:     { __participants: participants },
        });
        break;

      case 'remove_task':
        console.log(`[handler] triage remove_task ${action.taskId}: ${action.reason}`);
        await cancelTask(action.taskId);
        break;

      case 'reply':
        console.log(`[handler] triage reply: ${action.reason}`);
        await sendDiscordMessage(channelId, action.message, s.botToken); // flat, no reply link
        logMessage({ channel_id: channelId, content: action.message }, 'outgoing');
        break;

      default:
        console.warn(`[handler] unknown triage action: ${action.action}`);
    }
  }
}

// ── Group DM command handler ────────────────────────────────────────────────

async function handleGroupCommand(msg, channelId, body, s) {
  // body has front mentions already stripped, starts with "!"

  if (/^!help\s*$/i.test(body)) {
    const help =
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

  if (/^!tasks\s*$/i.test(body)) {
    await handleTasksCommand(channelId, msg.id, s);
    return;
  }

  const scheduleMatch = body.match(/^!schedule\s+(\S+)\s+([\s\S]+)$/i);
  if (scheduleMatch) {
    await handleScheduleCommand(msg, channelId, scheduleMatch[1], scheduleMatch[2].trim(), s);
    return;
  }

  const cancelMatch = body.match(/^!cancel\s+(\S+)\s*$/i);
  if (cancelMatch) {
    await handleCancelCommand(channelId, msg.id, normalizeId(cancelMatch[1]), s);
    return;
  }

  const pauseMatch = body.match(/^!pause\s+(\S+)\s*$/i);
  if (pauseMatch) {
    await handlePauseCommand(channelId, msg.id, normalizeId(pauseMatch[1]), s);
    return;
  }

  const resumeMatch = body.match(/^!resume\s+(\S+)\s*$/i);
  if (resumeMatch) {
    await handleResumeCommand(channelId, msg.id, normalizeId(resumeMatch[1]), s);
    return;
  }

  const runMatch = body.match(/^!run\s+(\S+)(.*)?$/i);
  if (runMatch) {
    await handleRunCommand(msg, channelId, runMatch[1].trim(), (runMatch[2] ?? '').trim(), s);
    return;
  }

  if (body.startsWith('!')) {
    const unknown = `Unknown command. Type \`!help\` to see available commands.`;
    await sendDiscordMessage(channelId, unknown, s.botToken, msg.id);
    logMessage({ channel_id: channelId, content: unknown }, 'outgoing');
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

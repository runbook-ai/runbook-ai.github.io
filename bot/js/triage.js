/**
 * Triager — lightweight LLM call that decides what to do with an incoming
 * group DM message. Uses function calling to return structured actions
 * (skip, add_task, remove_task, reply). Reads SOUL.md for bot identity
 * context. Heavy lifting is left to the planner.
 */

import { loadSettings } from './settings.js';
import { extensionCall } from './extension.js';
import { loadWorkspaceFile } from './memory-store.js';
import { DEFAULT_SOUL } from './planner.js';

// ── Tool definitions ────────────────────────────────────────────────────────

const TRIAGE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skip',
      description: 'This message does not need action from this bot.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why no action is needed' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Create a new task for this bot to execute.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this task should be created' },
          prompt: {
            type: 'string',
            description: 'Self-contained task prompt. The task executor has no access to chat history, so include all necessary details.',
          },
          label: {
            type: 'string',
            description: 'Short label (2-5 words) shown in the channel when the task reports results, e.g. "craigslist search", "site monitoring"',
          },
        },
        required: ['reason', 'prompt', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_task',
      description: 'Cancel an existing task.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this task should be cancelled' },
          taskId: { type: 'string', description: 'ID of the task to cancel' },
        },
        required: ['reason', 'taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply',
      description: 'Send a short text response to the channel without creating a task. Use for simple questions, status checks, confirmations, or brief answers that don\'t require work.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why a direct reply is appropriate' },
          message: { type: 'string', description: 'The message to send to the channel' },
        },
        required: ['reason', 'message'],
      },
    },
  },
];

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(botUsername, activeTasks, participants) {
  let taskList = 'None';
  if (activeTasks.length > 0) {
    taskList = activeTasks
      .map(t => {
        const preview = t.prompt.length > 80 ? t.prompt.slice(0, 77) + '...' : t.prompt;
        const label = t.label ? ` [${t.label}]` : '';
        return `- \`${t.id}\`${label}: ${preview}`;
      })
      .join('\n');
  }

  let participantList = 'Unknown';
  if (participants && participants.length > 0) {
    participantList = participants
      .map(p => `- ${p.username} (ID: ${p.id}${p.isBot ? ', bot' : ''})`)
      .join('\n');
  }

  const soul = loadWorkspaceFile('SOUL.md')?.trim() || DEFAULT_SOUL;
  const memoryMd = loadWorkspaceFile('MEMORY.md')?.trim();
  const memorySection = memoryMd ? `\n\nMemory:\n${memoryMd}\n` : '';

  return (
    `${soul}\n\n` +
    `Your role: triage agent for this bot (named "${botUsername}" on Discord). ` +
    `Read the conversation and decide what actions to take.\n\n` +
    `Channel participants:\n${participantList}\n\n` +
    `To mention someone in a reply, use <@USER_ID> (e.g. <@${participants?.[0]?.id || '123'}>).\n\n` +
    `You have these tools:\n` +
    `- skip — the message doesn't need a response from this bot\n` +
    `- add_task — create a new task with a clear, self-contained prompt\n` +
    `- remove_task — cancel an existing task by ID\n` +
    `- reply — send a short text response for simple questions, status checks, or confirmations\n\n` +
    `You may call multiple tools in one response (e.g. reply with status and add a new task).\n\n` +
    `Active tasks in this channel:\n${taskList}\n` +
    memorySection + `\n` +
    `Rules:\n` +
    `- Only act when the message is clearly directed at or relevant to this bot\n` +
    `- If users are talking to each other without involving this bot, skip\n` +
    `- Prefer skip when uncertain\n\n` +
    `Avoiding duplicates:\n` +
    `- Do NOT create a task if an active task already covers the same work\n` +
    `- If someone asks for something already in progress, use reply to tell them it's being worked on\n` +
    `- If someone refines or adjusts an active task, remove the old one and add a new one with merged instructions\n\n` +
    `Multi-bot awareness:\n` +
    `- If another bot in the conversation already responded to or claimed the request, skip\n` +
    `- If the message mentions another bot by name or @mention but not this bot, skip\n` +
    `- If this bot and another bot could both handle it but the other bot already started, skip\n\n` +
    `Reply guidelines:\n` +
    `- Use reply for questions that can be answered from the active task list or conversation context\n` +
    `- Use reply to acknowledge requests ("on it", "done") or explain why you're skipping\n` +
    `- Keep replies short — one or two sentences\n` +
    `- Do NOT reply just to be conversational — only reply when directly addressed\n\n` +
    `Task creation guidelines:\n` +
    `- Write a clear self-contained prompt — the task executor has no access to chat history\n` +
    `- Include all relevant details from the conversation (URLs, names, numbers, criteria)\n` +
    `- If the user's message is vague, include reasonable assumptions in the prompt rather than asking for clarification`
  );
}

// ── Buffer formatting ───────────────────────────────────────────────────────

function formatBuffer(buffer, latestMsg) {
  const lines = buffer.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const tag = m.isBot ? ' [bot]' : '';
    return `[${time}] ${m.author}${tag}: ${m.content}`;
  });

  const latestTime = new Date(latestMsg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const latestTag = latestMsg.isBot ? ' [bot]' : '';

  return (
    `Recent conversation:\n\n${lines.join('\n')}\n\n` +
    `Latest message (this triggered triage):\n` +
    `[${latestTime}] ${latestMsg.author}${latestTag}: ${latestMsg.content}`
  );
}

// ── Triage call ─────────────────────────────────────────────────────────────

/**
 * Call the triager LLM to decide what to do with a group DM message.
 *
 * @param {object} opts
 * @param {string} opts.botUsername - This bot's display name
 * @param {Array}  opts.buffer - Channel buffer entries
 * @param {object} opts.latestMsg - The message that triggered triage (buffer entry format)
 * @param {Array}  opts.activeTasks - Active tasks in this channel [{ id, prompt }]
 * @returns {Array<{ action: string, reason: string, prompt?: string, taskId?: string }>}
 */
export async function triage({ botUsername, buffer, latestMsg, activeTasks, participants }) {
  const s = loadSettings();
  const freeConfig = s.freeApiKey
    ? { llmBaseUrl: 'https://llm.runbookai.net/v1', llmApiKey: 'free' }
    : null;

  if (freeConfig) await extensionCall('setRemoteConfig', { config: freeConfig });

  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt(botUsername, activeTasks, participants) },
      { role: 'user', content: formatBuffer(buffer, latestMsg) },
    ];

    const args = { messages, tools: TRIAGE_TOOLS, role: 'triage', timeout: 30000 };

    for (let attempt = 0; attempt < 3; attempt++) {
      let resp;
      try {
        resp = await extensionCall('callLLMWithTools', args);
      } catch (err) {
        console.warn(`[triage] callLLMWithTools exception (${attempt + 1}/3):`, err.message);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        throw err;
      }
      if (resp.error) {
        console.warn(`[triage] callLLMWithTools .error (${attempt + 1}/3):`, resp.error);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        throw new Error(resp.message || resp.error);
      }

      // Parse tool calls into actions
      if (!resp.toolCalls?.length) {
        console.log('[triage] no tool calls returned, defaulting to skip');
        return [{ action: 'skip', reason: 'no tool calls returned by triager' }];
      }

      const actions = [];
      for (const call of resp.toolCalls) {
        const parsed = JSON.parse(call.function.arguments);
        actions.push({ action: call.function.name, ...parsed });
      }
      console.log(`[triage] ${actions.length} action(s):`, actions.map(a => a.action).join(', '));
      return actions;
    }
  } finally {
    if (freeConfig) {
      await extensionCall('setRemoteConfig', {
        config: { llmBaseUrl: null, llmApiKey: null },
      }).catch(() => {});
    }
  }

  return [{ action: 'skip', reason: 'triage failed after retries' }];
}

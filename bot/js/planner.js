/**
 * Planner — decomposes complex tasks into steps using LLM,
 * then executes each step via the extension.
 *
 * Two execution modes:
 *   think(messages, tools) → callLLMWithTools (reasoning + tool use)
 *   act(prompt)            → runHeadlessTask (browser interaction)
 */

import { loadSettings } from './settings.js';
import { createAndEnqueue } from './task-manager.js';

const EXTENSION_ID = 'kjbhngehjkiiecaflccjenmoccielojj';

/** Thrown when the user cancels a headless task in the extension. */
export class UserCancelledError extends Error {
  constructor() { super('Task cancelled by user'); }
}

// ── Extension messaging ────────────────────────────────────────────────────

async function extensionCall(action, args) {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('Runbook AI extension is not available on this page');
  }
  const resp = await chrome.runtime.sendMessage(EXTENSION_ID, { action, args });
  if (resp?.error) throw new Error(resp.message || resp.error);
  return resp;
}

/** LLM reasoning with tool use — no browser lock, fast and cheap. */
async function think(messages, tools) {
  const s = loadSettings();
  const freeConfig = s.freeApiKey
    ? { llmBaseUrl: 'https://llm.runbookai.net/v1', llmApiKey: 'free' }
    : null;

  // Apply free API config before the call
  if (freeConfig) await extensionCall('setRemoteConfig', { config: freeConfig });

  try {
    const args = { messages, tools, role: 'planner', timeout: 300000 };
    return await extensionCall('callLLMWithTools', args);
  } finally {
    // Restore original config
    if (freeConfig) {
      await extensionCall('setRemoteConfig', {
        config: { llmBaseUrl: null, llmApiKey: null },
      }).catch(() => {});
    }
  }
}

const ACT_TIMEOUT_MS = 300_000; // 5 minutes max per browse step

/**
 * Browser action — locks the extension for the duration.
 * Returns { text, files } where files is a map of savedFiles from taskState.
 */
async function act(prompt, savedFiles = {}) {
  const s = loadSettings();

  // Build config and initial taskState — bundled into one call so config
  // changes are scoped and don't leak if the task fails unexpectedly.
  const config = {
    ...(s.freeApiKey ? {
      llmBaseUrl: 'https://llm.runbookai.net/v1',
      llmApiKey:  'free',
    } : {}),
    returnTaskState: true,
  };

  const initialTaskState = Object.keys(savedFiles).length > 0
    ? { savedFiles }
    : null;

  // Race between the headless task and a timeout.
  // We wrap in a manually-controlled promise so we can reject it even if
  // chrome.runtime.sendMessage is stuck due to browser process overload.
  let settled = false;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Browse step timed out after 5 minutes'));
      }
    }, ACT_TIMEOUT_MS);

    extensionCall('runHeadlessTaskWithConfig', { prompt, initialTaskState, config })
      .then(resp => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(resp);
        }
      })
      .catch(err => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });

  // Extract saved files from taskState (if any were downloaded during browsing)
  const files = result?.taskState?.savedFiles || {};
  const text = result?.taskResult?.result || 'Task completed with no result.';

  // Detect user cancellation from the extension
  if (text === 'Task cancelled by user') {
    throw new UserCancelledError();
  }

  return { text, files };
}

// ── Planner tools ──────────────────────────────────────────────────────────

const PLANNER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browse',
      description: 'Navigate to a URL and perform a browser task. Use for anything requiring page interaction — searching websites, reading pages, filling forms, clicking buttons.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed instruction for what to do in the browser. Be specific about the URL and actions.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_check',
      description: 'Schedule a recurring browser check that runs automatically on an interval. Always specify maxRuns to limit how many times it runs. Optionally specify a stop condition so the check auto-completes early when the goal is met.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What to check on each run',
          },
          intervalMs: {
            type: 'number',
            description: 'Interval in milliseconds between runs (e.g. 7200000 for 2 hours)',
          },
          maxRuns: {
            type: 'number',
            description: 'Maximum number of times this check will run before auto-completing. Choose based on the interval and how long monitoring makes sense (e.g. 12 runs at 2h = 1 day, 36 runs at 2h = 3 days).',
          },
          stopCondition: {
            type: 'string',
            description: 'When this condition is met, the recurring check auto-completes and stops early. E.g. "buyer confirms pickup", "email reply received".',
          },
        },
        required: ['prompt', 'intervalMs', 'maxRuns'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description: 'Send a progress update or result to the user immediately, without ending the plan.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The message to send to the user',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'The plan is complete. Return the final summary and any data to remember. For recurring scheduled tasks, set stopReached to true when the stop condition has been met so the task auto-completes.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Final result to show the user',
          },
          memory: {
            type: 'object',
            description: 'Key data to persist for future runs (e.g. listings found, prices, URLs)',
          },
          stopReached: {
            type: 'boolean',
            description: 'Set to true when the stop condition for this recurring task has been met. The task will auto-complete and stop recurring.',
          },
        },
        required: ['summary'],
      },
    },
  },
];

const PLANNER_SYSTEM_PROMPT = `You are a task planner for Runbook AI. You break down user requests into concrete steps and execute them using the available tools.

You have access to:
- **browse**: Execute a task in a real browser (navigate, read pages, fill forms, click). Each browse call is independent — include all necessary context in the prompt.
- **schedule_check**: Set up a recurring automated check (e.g. monitor Gmail every 2 hours).
- **notify_user**: Send the user a progress update mid-plan.
- **done**: Finish the plan with a summary.

Guidelines:
- Break complex tasks into small, independent browser steps. Each browse prompt should be self-contained.
- After a browse step, analyze the results before deciding the next step.
- When the user asks for monitoring/follow-up, use schedule_check to set up recurring tasks. Always set a reasonable maxRuns based on the interval and task nature (e.g. checking every 2h for a day = 12 runs, monitoring daily for a week = 7 runs). If the user's request has a natural completion point (e.g. "notify me when someone replies", "check until the buyer confirms"), include a stopCondition so the task auto-completes early when the goal is met.
- For recurring tasks with a STOP CONDITION: when the condition is met, call done with stopReached=true. This will auto-complete the task and stop future runs.
- Include specific URLs, search terms, and criteria in browse prompts — don't assume the browser agent remembers previous steps.
- If a browse step fails, try an alternative approach before giving up.
- Send notify_user for important intermediate results so the user stays informed.
- Always end with done to provide a final summary.
- This may be a multi-turn conversation. Prior messages show what the user asked before and what you found. Use that context to handle follow-up requests (e.g. "reply to email 2" refers to an email listed in a previous response).
- IMPORTANT: Prefer lightweight pages. When gathering info, read aggregator/summary pages (HN comments, search results, API endpoints) rather than navigating to heavy media-rich external sites. Heavy pages can freeze the browser.
- If the user input contains <subTask>...</subTask> or <forEachItem>...</forEachItem> notations, pass them as-is to the browse tool prompt. Do not interpret, expand, or strip these tags — they are processed downstream by the browser agent.`;

// ── Conversation history ───────────────────────────────────────────────────

/**
 * Build the conversation history array for storage.
 * On first run, history is empty so we add the initial prompt + result.
 * On follow-up runs, the user's follow-up is already in history (appended
 * by applyFollowUp), so we just add the agent's new result.
 */
function buildHistory(existingHistory, prompt, result) {
  const newHistory = [...existingHistory];
  // If this is the first run, add the initial user message
  if (newHistory.length === 0) {
    newHistory.push({ role: 'user', content: prompt });
  }
  // Add the agent's result
  newHistory.push({ role: 'assistant', content: result });
  return newHistory;
}

// ── Planner loop ───────────────────────────────────────────────────────────

const MAX_STEPS = 10;
const MAX_BROWSE = 5;

/**
 * Run a multi-step plan for a task.
 *
 * @param {object} task - The task record
 * @param {function} onNotify - Called with (message) to deliver user notifications
 * @returns {{ result: string, memory?: object, history: Array }}
 */
export async function runPlan(task, onNotify) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
  ];

  // Separate image files (for vision) from non-image files (metadata only)
  const allFiles = task.files || {};
  const imageFiles = {};
  const otherFiles = {};
  for (const [k, f] of Object.entries(allFiles)) {
    if (f.mimeType && f.mimeType.startsWith('image/')) {
      imageFiles[k] = f;
    } else {
      otherFiles[k] = f;
    }
  }

  // Build text suffix for non-image attachments
  const otherFileNames = Object.keys(otherFiles);
  const nonImageSuffix = otherFileNames.length > 0
    ? '\n\nAttached files (available in browse steps for uploadFile):\n' +
      otherFileNames.map(k => {
        const f = otherFiles[k];
        const sizeKB = Math.round((f.size || 0) / 1024);
        return `- ${k} (${f.mimeType}, ${sizeKB}KB)`;
      }).join('\n')
    : '';

  // Build a multimodal user content array if there are images
  function buildUserContent(text) {
    const imageEntries = Object.entries(imageFiles);
    if (imageEntries.length === 0) return text;

    const parts = [{ type: 'text', text }];
    for (const [name, f] of imageEntries) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${f.mimeType};base64,${f.base64}` },
      });
      parts.push({ type: 'text', text: `(image: ${name})` });
    }
    return parts;
  }

  // Replay conversation history if this is a follow-up run
  const history = task.context?.history || [];
  if (history.length > 0) {
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }
  } else {
    // First run — original prompt + file info + inline images
    messages.push({ role: 'user', content: buildUserContent(task.prompt + nonImageSuffix) });
  }

  // Inject persistent memory (separate from conversation history)
  const { history: _h, ...contextWithoutHistory } = (task.context || {});
  if (Object.keys(contextWithoutHistory).length > 0) {
    messages.push({
      role: 'user',
      content: `Context from prior runs:\n${JSON.stringify(contextWithoutHistory, null, 2)}`,
    });
  }

  let collectedFiles = { ...(task.files || {}) };
  let browseCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await think(messages, PLANNER_TOOLS);

    // LLM returned tool calls
    if (resp.toolCalls) {
      for (const call of resp.toolCalls) {
        const args = JSON.parse(call.function.arguments);
        let toolResult;

        switch (call.function.name) {
          case 'browse': {
            if (browseCount >= MAX_BROWSE) {
              toolResult = { success: false, error: `Browse limit reached (${MAX_BROWSE}). Use the information you already have to finish the plan.` };
              break;
            }
            browseCount++;
            console.log('[planner] browse:', args.prompt.slice(0, 100));
            try {
              const browseResult = await act(args.prompt, collectedFiles);
              toolResult = { success: true, result: browseResult.text };
              // Collect any files downloaded during this browse step
              if (browseResult.files && Object.keys(browseResult.files).length > 0) {
                collectedFiles = { ...collectedFiles, ...browseResult.files };
                const fileNames = Object.keys(browseResult.files).join(', ');
                toolResult.downloadedFiles = fileNames;
              }
            } catch (err) {
              if (err instanceof UserCancelledError) throw err;
              toolResult = { success: false, error: err.message };
            }
            break;
          }

          case 'schedule_check': {
            const MAX_RUNS_CAP = 100;
            const maxRuns = Math.min(args.maxRuns || 24, MAX_RUNS_CAP);
            console.log('[planner] schedule_check:', args.prompt.slice(0, 80), 'every', args.intervalMs, 'ms, max', maxRuns, 'runs');
            let childPrompt = args.prompt;
            if (args.stopCondition) {
              childPrompt += `\n\nSTOP CONDITION: When this condition is met, call done with stopReached=true to auto-complete this task: ${args.stopCondition}`;
            }
            const child = await createAndEnqueue({
              prompt:    childPrompt,
              config:    task.config,
              channelId: task.channelId,
              replyToId: task.replyToId,
              createdBy: task.createdBy,
              schedule:  { type: 'every', intervalMs: args.intervalMs },
              maxRuns,
            });
            toolResult = { scheduled: true, taskId: child.id, intervalMs: args.intervalMs, maxRuns };
            break;
          }

          case 'notify_user': {
            console.log('[planner] notify_user:', args.message.slice(0, 80));
            if (onNotify) await onNotify(args.message);
            toolResult = { notified: true };
            break;
          }

          case 'done': {
            console.log('[planner] done', args.stopReached ? '(stop condition reached)' : '');
            // Build conversation history for future follow-ups
            const newHistory = buildHistory(history, task.prompt, args.summary);
            return {
              result: args.summary,
              memory: args.memory || null,
              history: newHistory,
              files: collectedFiles,
              stopReached: !!args.stopReached,
            };
          }

          default:
            toolResult = { error: `Unknown tool: ${call.function.name}` };
        }

        // Feed result back to LLM for next step
        messages.push({
          role: 'assistant',
          tool_calls: [call],
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    // LLM responded with plain text — treat as done
    if (resp.result?.text) {
      const newHistory = buildHistory(history, task.prompt, resp.result.text);
      return { result: resp.result.text, history: newHistory, files: collectedFiles };
    }
    if (resp.result && typeof resp.result === 'object') {
      const text = JSON.stringify(resp.result);
      const newHistory = buildHistory(history, task.prompt, text);
      return { result: text, history: newHistory };
    }

    // Unexpected response
    return { result: 'Plan ended unexpectedly.', history };
  }

  return { result: 'Plan reached maximum steps.', history };
}

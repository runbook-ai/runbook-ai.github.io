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
import { putTask } from './task-store.js';
import { buildWorkspaceContext } from './memory-store.js';

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
    for (let attempt = 0; attempt < 5; attempt++) {
      let resp;
      try {
        resp = await extensionCall('callLLMWithTools', args);
      } catch (err) {
        console.warn(`[planner] callLLMWithTools exception (${attempt + 1}/5):`, err.message);
        if (attempt < 4) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw err;
      }
      if (resp.error) {
        console.warn(`[planner] callLLMWithTools .error (${attempt + 1}/5):`, resp.error);
        if (attempt < 4) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error(resp.message || resp.error);
      }
      return resp;
    }
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

  const browseTrajectory = result?.taskState?.messages || null;
  const findings = result?.taskState?.findings || [];
  return { text, files, browseTrajectory, findings };
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
      name: 'spawn_task',
      description: 'Spawn a child task. Can be one-shot (runs once) or recurring (with schedule). The parent task can see child statuses on subsequent runs via the auto-injected CHILD TASK STATUSES context. Child tasks do not message the user — only the parent communicates via notify_user.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task prompt for the child. Be specific — include URLs, search terms, context. The child has no memory of the parent plan.',
          },
          schedule: {
            type: 'object',
            description: 'If set, makes this a recurring task. E.g. { "type": "every", "intervalMs": 7200000 } for every 2 hours. Omit for a one-shot task.',
          },
          maxRuns: {
            type: 'number',
            description: 'Maximum runs for recurring tasks. Choose based on interval and monitoring duration (e.g. 12 runs at 2h = 1 day). Required if schedule is set.',
          },
          stopCondition: {
            type: 'string',
            description: 'For recurring tasks: when this condition is met, the child auto-completes. E.g. "reply received", "item back in stock".',
          },
          context: {
            type: 'object',
            description: 'Initial context/memory to pass to the child (e.g. item details, URLs to monitor).',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_schedule',
      description: 'Make the CURRENT task recurring. After this run completes, the task will re-run on the specified interval. Use this when the current task itself needs to repeat (e.g. "check a website twice a day"). Do NOT use this if you just want to spawn a separate recurring child — use spawn_task with schedule for that.',
      parameters: {
        type: 'object',
        properties: {
          intervalMs: {
            type: 'number',
            description: 'Interval in milliseconds between runs (e.g. 43200000 for 12 hours)',
          },
          maxRuns: {
            type: 'number',
            description: 'Maximum number of times this task will run before auto-completing.',
          },
          stopCondition: {
            type: 'string',
            description: 'When this condition is met, call done with stopReached=true on a future run to auto-complete.',
          },
        },
        required: ['intervalMs', 'maxRuns'],
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
            description: 'Structured data to persist for future runs of this task (e.g. items found, prices, URLs). This REPLACES all previous memory — include everything you want to keep, not just new findings.',
          },
          runSummary: {
            type: 'string',
            description: 'For recurring tasks: a cumulative summary of all runs so far including this one. You will see the previous runSummary on the next run — update it to cover all runs. Keep it concise but comprehensive.',
          },
          learnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key learnings to remember across all future tasks (e.g. user preferences, useful URLs, important facts). Each entry is one standalone insight.',
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

const DEFAULT_SOUL = `You are a task planner for Runbook AI. You break down user requests into concrete steps and execute them using the available tools.`;

const DEFAULT_AGENTS = `You have access to:
- **browse**: Execute a task in a real browser (navigate, read pages, fill forms, click). Each browse call is independent — include all necessary context in the prompt. Each call has a limited execution budget (~30 browser actions) — keep prompts focused on a single objective. The result may include a \`browserFindings\` array — review these and include any worth keeping in your \`learnings\`.
- **spawn_task**: Spawn a child task (one-shot or recurring). Child tasks run independently and do NOT message the user — only you (the parent) communicate with the user. You will see child task statuses automatically on subsequent runs via CHILD TASK STATUSES context.
- **set_schedule**: Make the CURRENT task recurring so it re-runs on an interval. Use this when the task itself needs to repeat (e.g. "check twice a day"). The task will keep running until maxRuns is reached or you call done with stopReached=true.
- **notify_user**: Send the user a progress update mid-plan.
- **done**: Finish the plan with a summary. Always populate these fields when relevant:
  - **memory**: structured data for future runs of THIS task (replaces previous memory entirely — include everything to keep)
  - **runSummary**: for recurring tasks, a cumulative prose summary covering ALL runs so far (you'll see the previous one on the next run — update it)
  - **learnings**: insights worth remembering across ALL future tasks (user preferences, useful URLs, key facts)

Guidelines:
- Break complex tasks into small, independent browser steps. Each browse prompt should be self-contained.
- After a browse step, analyze the results before deciding the next step.
- For complex multi-stage workflows, use a parent-child pattern:
  - Use set_schedule on the parent task for the main recurring loop (e.g. checking a website periodically).
  - Use spawn_task to create independent child tasks for per-item work (e.g. one child per result to handle follow-up actions independently).
  - On each parent run, check CHILD TASK STATUSES to see which children completed, then notify_user with relevant updates.
  - Child tasks are silent — they never message the user. The parent is responsible for all user communication.
- For recurring tasks with a STOP CONDITION: when the condition is met, call done with stopReached=true. This will auto-complete the task and stop future runs.
- Include specific URLs, search terms, and criteria in browse prompts — don't assume the browser agent remembers previous steps.
- When spawning child tasks, include all necessary context in the prompt and context fields — children cannot see the parent's memory.
- If a browse step fails, try an alternative approach before giving up.
- Send notify_user for important intermediate results so the user stays informed.
- Always end with done to provide a final summary.
- For recurring tasks: ALWAYS include runSummary and memory in done(). runSummary should cover all runs including the current one. memory should contain structured state you need on the next run.
- This may be a multi-turn conversation. Prior messages show what the user asked before and what you found. Use that context to handle follow-up requests (e.g. "reply to email 2" refers to an email listed in a previous response).
- IMPORTANT: Prefer lightweight pages. When gathering info, read aggregator/summary pages (HN comments, search results, API endpoints) rather than navigating to heavy media-rich external sites. Heavy pages can freeze the browser.
- If the user input contains <subTask>...</subTask> or <forEachItem>...</forEachItem> notations, pass them as-is to the browse tool prompt. Do not interpret, expand, or strip these tags — they are processed downstream by the browser agent.`;

export { DEFAULT_SOUL, DEFAULT_AGENTS };

// ── Planner loop ───────────────────────────────────────────────────────────

const MAX_STEPS = 10;
const MAX_BROWSE = 5;

/**
 * Run a multi-step plan for a task.
 *
 * @param {object} task - The task record
 * @param {function} onNotify - Called with (message) to deliver user notifications
 * @returns {{ result: string, memory?: object, runSummary?: string, learnings?: string[], files?: object, stopReached?: boolean }}
 */
export async function runPlan(task, onNotify) {
  const scheduleNote = task.schedule ? ' This is a recurring task.' : '';
  const { soul, agents, memory } = await buildWorkspaceContext();
  const systemPrompt = [
    soul || DEFAULT_SOUL,
    '\n\n',
    agents || DEFAULT_AGENTS,
    memory,
    `\n\nCurrent date time: ${new Date().toString()}\nRun #${task.runCount} of this task.${scheduleNote}`,
  ].join('');
  const messages = [
    { role: 'system', content: systemPrompt },
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

  // Replay conversation history (reply-chain from Discord) and add current prompt
  const history = task.context?.history || [];
  if (history.length > 0) {
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: buildUserContent(task.prompt + nonImageSuffix) });

  // Inject run summary from previous runs (replaces growing history for recurring tasks)
  const runSummary = task.context?.__runSummary;
  if (runSummary) {
    messages.push({
      role: 'user',
      content: `Summary of previous runs (runs 1-${task.runCount - 1}):\n${runSummary}`,
    });
  }

  // Inject persistent structured memory (separate from meta fields)
  const { history: _h, __childStatuses: _cs, __runSummary: _rs, __trajectory: _tr, __browseTrajectories: _bt, ...contextWithoutMeta } = (task.context || {});
  if (Object.keys(contextWithoutMeta).length > 0) {
    messages.push({
      role: 'user',
      content: `Context from prior runs:\n${JSON.stringify(contextWithoutMeta, null, 2)}`,
    });
  }

  // Inject child task statuses so the planner can react to child completions
  const childStatuses = task.context?.__childStatuses;
  if (childStatuses && childStatuses.length > 0) {
    messages.push({
      role: 'user',
      content: `CHILD TASK STATUSES:\n${JSON.stringify(childStatuses, null, 2)}\n\nChild tasks do not message the user. Use notify_user to inform the user about important child task results.`,
    });
  }

  let collectedFiles = { ...(task.files || {}) };
  let browseCount = 0;
  const maxBrowse = MAX_BROWSE;
  const browseTrajectories = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await think(messages, PLANNER_TOOLS);

    // LLM returned tool calls
    if (resp.toolCalls) {
      // Push one assistant message with all tool calls (preserves thought_signature)
      messages.push({
        role: 'assistant',
        tool_calls: resp.toolCalls,
      });

      for (const call of resp.toolCalls) {
        const args = JSON.parse(call.function.arguments);
        let toolResult;

        switch (call.function.name) {
          case 'browse': {
            if (browseCount >= maxBrowse) {
              toolResult = { success: false, error: `Browse limit reached (${maxBrowse}). Use the information you already have to finish the plan.` };
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
              // Save browse-level trajectory (not sent to planner LLM)
              if (browseResult.browseTrajectory) {
                browseTrajectories.push({
                  step: browseCount,
                  prompt: args.prompt,
                  trajectory: browseResult.browseTrajectory,
                });
              }
              // Expose browser agent findings to planner LLM
              if (browseResult.findings.length > 0) {
                toolResult.browserFindings = browseResult.findings;
              }
            } catch (err) {
              if (err instanceof UserCancelledError) throw err;
              toolResult = { success: false, error: err.message };
            }
            break;
          }

          case 'spawn_task': {
            const MAX_RUNS_CAP = 100;
            const maxRuns = args.maxRuns ? Math.min(args.maxRuns, MAX_RUNS_CAP) : null;
            const schedule = args.schedule || null;
            console.log('[planner] spawn_task:', args.prompt.slice(0, 80),
              schedule ? `every ${schedule.intervalMs}ms, max ${maxRuns} runs` : '(one-shot)');
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
              schedule,
              maxRuns,
              parentId:  task.id,
            });
            // Pass initial context to child if provided
            if (args.context && typeof args.context === 'object') {
              child.context = { ...child.context, ...args.context };
              await putTask(child);
            }
            toolResult = { spawned: true, taskId: child.id, schedule: schedule ? { intervalMs: schedule.intervalMs, maxRuns } : 'one-shot' };
            break;
          }

          case 'set_schedule': {
            const MAX_RUNS_CAP = 100;
            const maxRuns = Math.min(args.maxRuns || 24, MAX_RUNS_CAP);
            console.log('[planner] set_schedule: every', args.intervalMs, 'ms, max', maxRuns, 'runs');
            task.schedule = { type: 'every', intervalMs: args.intervalMs };
            task.maxRuns  = maxRuns;
            if (args.stopCondition) {
              task.prompt += `\n\nSTOP CONDITION: When this condition is met, call done with stopReached=true to auto-complete this task: ${args.stopCondition}`;
            }
            await putTask(task);
            toolResult = { scheduled: true, intervalMs: args.intervalMs, maxRuns };
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
            return {
              result: args.summary,
              memory: args.memory || null,
              runSummary: args.runSummary || null,
              learnings: args.learnings || null,
              trajectory: messages, browseTrajectories,
              files: collectedFiles,
              stopReached: !!args.stopReached,
            };
          }

          default:
            toolResult = { error: `Unknown tool: ${call.function.name}` };
        }

        // Feed tool result back for this call
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
      return { result: resp.result.text, trajectory: messages, browseTrajectories, files: collectedFiles };
    }
    if (resp.result && typeof resp.result === 'object') {
      return { result: JSON.stringify(resp.result), trajectory: messages, browseTrajectories };
    }

    // Unexpected response
    return { result: 'Plan ended unexpectedly.', trajectory: messages, browseTrajectories };
  }

  return { result: 'Plan reached maximum steps.', trajectory: messages, browseTrajectories };
}

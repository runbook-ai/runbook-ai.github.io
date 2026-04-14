/**
 * Planner — decomposes complex tasks into steps using LLM,
 * then executes each step via the extension.
 *
 * Two execution modes:
 *   think(messages, tools) → callLLMWithTools (reasoning + tool use)
 *   act(prompt)            → runHeadlessTask (browser interaction)
 */

import { loadSettings } from './settings.js';
import { createAndEnqueue, cancelTask } from './task-manager.js';
import { putTask } from './task-store.js';
import { buildWorkspaceContext } from './memory-store.js';
import { readFile, writeFile, appendFile, listFiles, deleteFile, fileInfo, grepFiles } from './file-store.js';
import { extensionCall } from './extension.js';

/** Thrown when the user cancels a headless task in the extension. */
export class UserCancelledError extends Error {
  constructor() { super('Task cancelled by user'); }
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
      description: 'Spawn a child task. Can be one-shot (runs once) or recurring (with schedule). The parent task can see child statuses on subsequent runs via the auto-injected CHILD TASK STATUSES context. Child tasks do not message the user — the parent communicates results via done().',
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
      name: 'cancel_task',
      description: 'Cancel a child task and all its descendants. Use when a child task is no longer needed (e.g. user changed direction, task is obsolete). See CHILD TASK STATUSES for available task IDs.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The ID of the child task to cancel',
          },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from persistent storage. Returns the file content. Use for text files (CSV, JSON, markdown, etc.).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g. "reports/daily.md", "data/prices.csv")' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file in persistent storage. Creates or overwrites. Files persist across task runs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content. For binary files, provide base64-encoded string.' },
          mimeType: { type: 'string', description: 'MIME type (e.g. "text/csv", "image/png"). Default: text/plain' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding. Default: utf8' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to an existing text file. Creates the file if it doesn\'t exist. Use for logs, CSVs, and other append-only data.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to append (added to the end of the file)' },
          mimeType: { type: 'string', description: 'MIME type if creating new file. Default: text/plain' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in persistent storage, optionally filtered by path prefix.',
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional path prefix filter (e.g. "reports/")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from persistent storage.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get file metadata (size, type, last modified) without loading content. Use for binary files or large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description: 'Search through file contents for a keyword or pattern. Returns matching files with line numbers and snippets. Skips binary files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search string or regex pattern (e.g. "/price.*\\d+/i")' },
          prefix: { type: 'string', description: 'Optional path prefix to limit search scope' },
          maxResults: { type: 'number', description: 'Max matching files to return. Default: 10' },
        },
        required: ['query'],
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
          silent: {
            type: 'boolean',
            description: 'Set to true to suppress sending the summary to the user. Use for recurring task runs with nothing new to report. Default: false (summary is always sent to user).',
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

const DEFAULT_SOUL = `You are Runbook AI, a bot that helps users automate tasks through a real browser. You can navigate websites, read pages, fill forms, scrape data, and monitor sites on a schedule.`;

const DEFAULT_AGENTS = `You have access to:
- **browse**: Execute a task in a real browser (navigate, read pages, fill forms, click). Each browse call is independent — include all necessary context in the prompt. Each call has a limited execution budget (~30 browser actions) — keep prompts focused on a single objective. The result may include a \`browserFindings\` array — review these and include any worth keeping in your \`learnings\`.
- **spawn_task**: Spawn a child task (one-shot or recurring). Child tasks run independently and do NOT message the user — only you (the parent) communicate with the user. You will see child task statuses automatically on subsequent runs via CHILD TASK STATUSES context.
- **set_schedule**: Make the CURRENT task recurring so it re-runs on an interval. Use this when the task itself needs to repeat (e.g. "check twice a day"). The task will keep running until maxRuns is reached or you call done with stopReached=true.
- **cancel_task**: Cancel a child task and all its descendants. Use when a child is no longer needed (e.g. user changed direction).
- **read_file / write_file / append_file / list_files / delete_file / file_info / grep_files**: Persistent file storage. Use to save reports, CSVs, data, images, etc. that persist across task runs. Use append_file for logs and CSVs where you add rows over time. Files are synced to GitHub.
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
  - On each parent run, check CHILD TASK STATUSES to see which children completed, then report relevant updates in done().
  - Child tasks are silent — they never message the user. The parent is responsible for all user communication.
- For recurring tasks with a STOP CONDITION: when the condition is met, call done with stopReached=true. This will auto-complete the task and stop future runs.
- Include specific URLs, search terms, and criteria in browse prompts — don't assume the browser agent remembers previous steps.
- When spawning child tasks, include all necessary context in the prompt and context fields — children cannot see the parent's memory.
- If a browse step fails, try an alternative approach before giving up.
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
 * @returns {{ result: string, memory?: object, runSummary?: string, learnings?: string[], files?: object, stopReached?: boolean }}
 */
export async function runPlan(task) {
  const scheduleNote = task.schedule ? ' This is a recurring task.' : '';
  const { soul, agents, memory } = await buildWorkspaceContext();

  // Build participant context for group DM tasks
  let participantNote = '';
  const participants = task.context?.__participants;
  if (participants && participants.length > 0) {
    const list = participants
      .map(p => `- ${p.username} (ID: ${p.id}${p.isBot ? ', bot' : ''})`)
      .join('\n');
    participantNote = `\n\nChannel participants:\n${list}\nTo mention someone, use <@USER_ID> in your message.`;
  }

  const systemPrompt = [
    soul || DEFAULT_SOUL,
    '\n\nYour role: break down user requests into concrete steps and execute them using the available tools.\n\n',
    agents || DEFAULT_AGENTS,
    memory,
    participantNote,
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

  // Replay conversation history and add current prompt
  const history = task.context?.history || [];
  if (history.length > 0) {
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    if (task.context?.__hasNewInput) {
      // New follow-up input from user
      messages.push({ role: 'user', content: buildUserContent(task.prompt + nonImageSuffix) });
    } else {
      // Normal recurring run — generic nudge without repeating the prompt
      messages.push({ role: 'user', content: 'Recurring run. Refer to the conversation above and task context below for what to do.' });
    }
  } else {
    messages.push({ role: 'user', content: buildUserContent(task.prompt + nonImageSuffix) });
  }

  // Build combined task context message
  // Extract non-meta fields (anything not __ prefixed and not history) as structured memory
  const contextWithoutMeta = {};
  for (const [k, v] of Object.entries(task.context || {})) {
    if (k !== 'history' && !k.startsWith('__')) contextWithoutMeta[k] = v;
  }
  const taskContextSections = [];

  if (task.context?.__hasNewInput) {
    taskContextSections.push('## New user input\nThe user sent new input for this ongoing task. Review and adjust as needed — you may cancel_task obsolete children, spawn new ones, change the schedule, or simply respond. Do not restart work that is still valid.');
    delete task.context.__hasNewInput;
  }

  const runSummary = task.context?.__runSummary;
  if (runSummary) {
    taskContextSections.push(`## Previous runs summary (runs 1-${task.runCount - 1})\n${runSummary}`);
  }

  if (Object.keys(contextWithoutMeta).length > 0) {
    taskContextSections.push(`## Structured memory\n${JSON.stringify(contextWithoutMeta, null, 2)}`);
  }

  const childStatuses = task.context?.__childStatuses;
  if (childStatuses && childStatuses.length > 0) {
    taskContextSections.push(`## Child task statuses\n${JSON.stringify(childStatuses, null, 2)}\n\nChild tasks do not message the user. Report child task results in your done() summary.`);
  }

  const stopCondition = task.context?.__stopCondition;
  if (stopCondition) {
    taskContextSections.push(`## Stop condition\nWhen this condition is met, call done with stopReached=true to auto-complete this task: ${stopCondition}`);
  }

  if (taskContextSections.length > 0) {
    messages.push({
      role: 'user',
      content: `Task context:\n\n${taskContextSections.join('\n\n')}`,
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
              const browsePrompt = args.prompt + '\n\nWhen done, close any browser tabs you opened that are no longer needed.';
              const browseResult = await act(browsePrompt, collectedFiles);
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
            const childPrompt = args.prompt;
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
            // Pass initial context and stop condition to child
            if ((args.context && typeof args.context === 'object') || args.stopCondition) {
              if (args.context) child.context = { ...child.context, ...args.context };
              if (args.stopCondition) child.context.__stopCondition = args.stopCondition;
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
              task.context.__stopCondition = args.stopCondition;
            }
            await putTask(task);
            toolResult = { scheduled: true, intervalMs: args.intervalMs, maxRuns };
            break;
          }

          case 'cancel_task': {
            console.log('[planner] cancel_task:', args.taskId);
            const cancelled = await cancelTask(args.taskId);
            toolResult = cancelled
              ? { cancelled: true, taskId: args.taskId }
              : { cancelled: false, error: `Task ${args.taskId} not found` };
            break;
          }

          case 'read_file': {
            console.log('[planner] read_file:', args.path);
            const file = await readFile(args.path);
            toolResult = file
              ? { path: file.path, content: file.content, mimeType: file.mimeType, encoding: file.encoding || 'utf8', size: file.size }
              : { error: `File not found: ${args.path}` };
            break;
          }

          case 'write_file': {
            console.log('[planner] write_file:', args.path);
            const written = await writeFile(args.path, args.content, {
              mimeType: args.mimeType || 'text/plain',
              encoding: args.encoding || 'utf8',
            });
            toolResult = { written: true, path: written.path, size: written.size };
            break;
          }

          case 'append_file': {
            console.log('[planner] append_file:', args.path);
            const appended = await appendFile(args.path, args.content, {
              mimeType: args.mimeType || 'text/plain',
            });
            toolResult = { appended: true, path: appended.path, size: appended.size };
            break;
          }

          case 'list_files': {
            console.log('[planner] list_files:', args.prefix || '(all)');
            const files = await listFiles(args.prefix || '');
            toolResult = { files, count: files.length };
            break;
          }

          case 'delete_file': {
            console.log('[planner] delete_file:', args.path);
            const deleted = await deleteFile(args.path);
            toolResult = deleted
              ? { deleted: true, path: args.path }
              : { deleted: false, error: `File not found: ${args.path}` };
            break;
          }

          case 'file_info': {
            console.log('[planner] file_info:', args.path);
            const info = await fileInfo(args.path);
            toolResult = info || { error: `File not found: ${args.path}` };
            break;
          }

          case 'grep_files': {
            console.log('[planner] grep_files:', args.query);
            toolResult = await grepFiles(args.query, {
              prefix: args.prefix || '',
              maxResults: args.maxResults || 10,
            });
            break;
          }

          case 'done': {
            console.log('[planner] done', args.stopReached ? '(stop condition reached)' : '', args.silent ? '(silent)' : '');
            return {
              result: args.summary,
              memory: args.memory || null,
              runSummary: args.runSummary || null,
              learnings: args.learnings || null,
              silent: !!args.silent,
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

  // Step limit reached — give the planner one last chance to finish with done
  const DONE_ONLY = PLANNER_TOOLS.filter(t => t.function.name === 'done');
  messages.push({
    role: 'user',
    content: 'Step limit reached. You MUST call done now with your best effort summary, including memory, runSummary, and learnings if applicable.',
  });
  try {
    const forceResp = await think(messages, DONE_ONLY);
    if (forceResp.toolCalls) {
      const doneCall = forceResp.toolCalls.find(c => c.function.name === 'done');
      if (doneCall) {
        const args = JSON.parse(doneCall.function.arguments);
        return {
          result: args.summary || 'Plan reached maximum steps.',
          memory: args.memory || null,
          runSummary: args.runSummary || null,
          learnings: args.learnings || null,
          silent: !!args.silent,
          trajectory: messages, browseTrajectories,
          files: collectedFiles,
          stopReached: !!args.stopReached,
        };
      }
    }
  } catch (err) {
    console.warn('[planner] forced done failed:', err.message);
  }
  return { result: 'Plan reached maximum steps.', trajectory: messages, browseTrajectories };
}

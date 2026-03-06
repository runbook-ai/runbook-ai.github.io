/**
 * Planner — decomposes complex tasks into steps using LLM,
 * then executes each step via the extension.
 *
 * Two execution modes:
 *   think(messages)     → callLLM (pure reasoning, no browser)
 *   act(prompt)         → runHeadlessTask (browser interaction)
 */

import { loadSettings } from './settings.js';
import { createAndEnqueue } from './task-manager.js';

const EXTENSION_ID = 'kjbhngehjkiiecaflccjenmoccielojj';

// ── Extension messaging ────────────────────────────────────────────────────

async function extensionCall(action, args) {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('Runbook AI extension is not available on this page');
  }
  const resp = await chrome.runtime.sendMessage(EXTENSION_ID, { action, args });
  if (resp?.error) throw new Error(resp.message || resp.error);
  return resp;
}

/** Pure reasoning — no browser lock, fast and cheap. */
async function think(messages, tools = null) {
  const action = tools ? 'callLLMWithTools' : 'callLLM';
  const args = { messages, role: 'worker', timeout: 60000 };
  if (tools) args.tools = tools;
  return extensionCall(action, args);
}

/** Browser action — locks the extension for the duration. */
async function act(prompt) {
  const s = loadSettings();

  // Ensure side panel is open
  await extensionCall('openSidePanel', {});
  await new Promise(r => setTimeout(r, 500));

  // Set config
  await extensionCall('setRemoteConfig', {
    config: {
      ...(s.freeApiKey ? {
        llmBaseUrl: 'https://llm.runbookai.net/v1',
        llmApiKey:  'free',
      } : {}),
      returnTaskState: true,
    },
  });

  const resp = await extensionCall('runHeadlessTask', { prompt });

  // Switch back to bot tab
  const botUrl = document.location.href;
  const botTab = resp?.taskState?.tabs?.find(t => t.url && t.url === botUrl);
  if (botTab?.tabId != null) {
    chrome.runtime.sendMessage(EXTENSION_ID, {
      action: 'switchToTab',
      args: { tabId: botTab.tabId },
    }).catch(() => {});
  }

  return resp?.taskResult?.result || 'Task completed with no result.';
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
      description: 'Schedule a recurring browser check that runs automatically on an interval.',
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
        },
        required: ['prompt', 'intervalMs'],
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
      description: 'The plan is complete. Return the final summary and any data to remember.',
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
- When the user asks for monitoring/follow-up, use schedule_check to set up recurring tasks.
- Include specific URLs, search terms, and criteria in browse prompts — don't assume the browser agent remembers previous steps.
- If a browse step fails, try an alternative approach before giving up.
- Send notify_user for important intermediate results so the user stays informed.
- Always end with done to provide a final summary.`;

// ── Planner loop ───────────────────────────────────────────────────────────

const MAX_STEPS = 10;

/**
 * Run a multi-step plan for a task.
 *
 * @param {object} task - The task record
 * @param {function} onNotify - Called with (message) to deliver user notifications
 * @returns {{ result: string, memory?: object }}
 */
export async function runPlan(task, onNotify) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: task.prompt },
  ];

  // Inject context from prior runs
  if (task.context && Object.keys(task.context).length > 0) {
    messages.push({
      role: 'user',
      content: `Context from prior runs:\n${JSON.stringify(task.context, null, 2)}`,
    });
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await think(messages, PLANNER_TOOLS);

    // LLM returned tool calls
    if (resp.toolCalls) {
      for (const call of resp.toolCalls) {
        const args = JSON.parse(call.function.arguments);
        let toolResult;

        switch (call.function.name) {
          case 'browse': {
            console.log('[planner] browse:', args.prompt.slice(0, 100));
            try {
              const browseResult = await act(args.prompt);
              toolResult = { success: true, result: browseResult };
            } catch (err) {
              toolResult = { success: false, error: err.message };
            }
            break;
          }

          case 'schedule_check': {
            console.log('[planner] schedule_check:', args.prompt.slice(0, 80), 'every', args.intervalMs, 'ms');
            const child = await createAndEnqueue({
              prompt:    args.prompt,
              config:    task.config,
              channelId: task.channelId,
              replyToId: task.replyToId,
              createdBy: task.createdBy,
              schedule:  { type: 'every', intervalMs: args.intervalMs },
            });
            toolResult = { scheduled: true, taskId: child.id, intervalMs: args.intervalMs };
            break;
          }

          case 'notify_user': {
            console.log('[planner] notify_user:', args.message.slice(0, 80));
            if (onNotify) await onNotify(args.message);
            toolResult = { notified: true };
            break;
          }

          case 'done': {
            console.log('[planner] done');
            return {
              result: args.summary,
              memory: args.memory || null,
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
      return { result: resp.result.text };
    }
    if (resp.result && typeof resp.result === 'object') {
      return { result: JSON.stringify(resp.result) };
    }

    // Unexpected response
    return { result: 'Plan ended unexpectedly.' };
  }

  return { result: 'Plan reached maximum steps.' };
}
